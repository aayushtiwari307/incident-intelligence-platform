-- 0007_alert_integrations: organization-scoped integration credentials and alert-cycle deduplication (Milestone 7).
--
-- Design rules enforced HERE, not only in application code:
--   * an integration belongs to exactly one organization; its bearer token is stored only as a SHA-256 hash (unique)
--   * an integration is soft-revoked (revoked_at), never deleted, so its dedupe history survives and the token hash stays
--     reserved; rotation replaces the hash in place, so the integration id (the dedupe identity) never changes
--   * one alert CYCLE = (integration, fingerprint, startsAt). A UNIQUE constraint makes a second incident for the same
--     cycle impossible even if two requests race past every application check
--   * a cycle row and any incident it created are in the same organization (composite foreign keys); one incident
--     belongs to at most one cycle
--   * a resolved notification for an unseen cycle is persisted as a tombstone (NULL incident_id), preventing a late
--     firing notification from creating a phantom incident for an already-resolved cycle
--   * a resolved cycle always records when it was resolved

CREATE TABLE integrations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  kind            text        NOT NULL DEFAULT 'alertmanager',
  name            text        NOT NULL,
  token_hash      text        NOT NULL,
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  rotated_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  rotated_at      timestamptz,
  revoked_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  CONSTRAINT integrations_org_id_key UNIQUE (organization_id, id),   -- target of composite foreign keys
  CONSTRAINT integrations_token_hash_key UNIQUE (token_hash),
  CONSTRAINT integrations_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT integrations_kind_valid CHECK (kind IN ('alertmanager')),
  CONSTRAINT integrations_name_length CHECK (char_length(name) BETWEEN 1 AND 60 AND name = btrim(name))
);

-- Names are unique per organization among ACTIVE integrations only (a revoked name can be reused).
CREATE UNIQUE INDEX integrations_org_active_name_key ON integrations (organization_id, lower(name)) WHERE revoked_at IS NULL;
CREATE INDEX integrations_org_created_idx ON integrations (organization_id, created_at DESC, id);

CREATE TABLE alert_cycles (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL,
  integration_id  uuid        NOT NULL,
  fingerprint     text        NOT NULL,
  -- Normalised start of the cycle (sender's RFC 3339 startsAt, converted to UTC and truncated to microseconds).
  starts_at       timestamptz NOT NULL,
  -- NULL means a tombstone: the first notification observed for this identity was already resolved.
  incident_id     uuid,
  state           text        NOT NULL DEFAULT 'firing',
  delivery_count  integer     NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  CONSTRAINT alert_cycles_dedupe_key UNIQUE (integration_id, fingerprint, starts_at),
  CONSTRAINT alert_cycles_incident_key UNIQUE (organization_id, incident_id),
  CONSTRAINT alert_cycles_integration_fkey
    FOREIGN KEY (organization_id, integration_id) REFERENCES integrations (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_cycles_incident_fkey
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT alert_cycles_fingerprint_format CHECK (fingerprint ~ '^[A-Za-z0-9._:-]{1,128}$'),
  CONSTRAINT alert_cycles_state_valid CHECK (state IN ('firing', 'resolved')),
  CONSTRAINT alert_cycles_delivery_count_positive CHECK (delivery_count >= 1),
  CONSTRAINT alert_cycles_resolved_consistent CHECK ((state = 'resolved') = (resolved_at IS NOT NULL))
);

CREATE INDEX alert_cycles_integration_idx ON alert_cycles (organization_id, integration_id, last_seen_at DESC);
