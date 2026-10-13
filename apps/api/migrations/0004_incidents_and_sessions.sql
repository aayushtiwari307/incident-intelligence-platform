-- 0004_incidents_and_sessions: opaque revocable sessions, incidents, an append-only timeline, invitations.
--
-- Design rules enforced HERE, not only in application code:
--   * a session's active organization must be one the user is a member of (composite FK)
--   * an incident's assignee must be a member of the incident's own organization (composite FK)
--   * timeline rows can never be updated, and only deleted when their organization is deleted
--   * every UPDATE of an incident bumps `version` (optimistic concurrency cannot be bypassed)
--   * incident status changes must follow the allowed transition graph
--   * an incident is "resolved" exactly when resolved_at is set

-- ---------------------------------------------------------------------------------------------
-- Sessions: store a hash of an opaque random token (the token itself is only ever in the cookie).
-- No session was ever issued by the application before this migration, so existing rows (which have no
-- token) are unusable and are removed.
DELETE FROM auth_sessions;
ALTER TABLE auth_sessions
  ADD COLUMN token_hash      text NOT NULL,
  ADD COLUMN organization_id uuid,
  ADD CONSTRAINT auth_sessions_token_hash_key UNIQUE (token_hash),
  ADD CONSTRAINT auth_sessions_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- Active organization: must be a membership of this very user. If the membership is removed the
  -- session stays valid but loses its active organization (the user must pick another).
  ADD CONSTRAINT auth_sessions_active_membership_fkey
    FOREIGN KEY (organization_id, user_id) REFERENCES memberships (organization_id, user_id)
    ON DELETE SET NULL (organization_id);

-- ---------------------------------------------------------------------------------------------
-- Incident numbering: a per-organization counter, incremented inside the creating transaction.
CREATE TABLE incident_counters (
  organization_id uuid    PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  last_number     integer NOT NULL DEFAULT 0 CHECK (last_number >= 0)
);

-- ---------------------------------------------------------------------------------------------
CREATE TABLE incidents (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  number          integer     NOT NULL CHECK (number > 0),
  title           text        NOT NULL,
  description     text        NOT NULL DEFAULT '',
  severity        text        NOT NULL,
  status          text        NOT NULL DEFAULT 'triggered',
  assignee_id     uuid,
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  version         integer     NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  mitigated_at    timestamptz,
  resolved_at     timestamptz,
  CONSTRAINT incidents_org_id_key UNIQUE (organization_id, id),            -- target of composite FKs
  CONSTRAINT incidents_org_number_key UNIQUE (organization_id, number),
  CONSTRAINT incidents_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  CONSTRAINT incidents_description_length CHECK (char_length(description) <= 10000),
  CONSTRAINT incidents_severity_valid CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  CONSTRAINT incidents_status_valid CHECK (status IN ('triggered', 'acknowledged', 'investigating', 'mitigated', 'resolved')),
  CONSTRAINT incidents_resolved_consistent CHECK ((status = 'resolved') = (resolved_at IS NOT NULL)),
  -- The assignee must belong to the same organization. MATCH SIMPLE: not enforced while assignee_id is NULL.
  CONSTRAINT incidents_assignee_membership_fkey
    FOREIGN KEY (organization_id, assignee_id) REFERENCES memberships (organization_id, user_id)
    ON DELETE SET NULL (assignee_id)
);

CREATE INDEX incidents_org_created_idx  ON incidents (organization_id, created_at DESC, id DESC);
CREATE INDEX incidents_org_status_idx   ON incidents (organization_id, status, created_at DESC, id DESC);
CREATE INDEX incidents_org_assignee_idx ON incidents (organization_id, assignee_id) WHERE assignee_id IS NOT NULL;

-- Every update bumps the version and the timestamp, whatever the caller wrote.
CREATE FUNCTION incidents_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.version    := OLD.version + 1;
  NEW.updated_at := now();
  IF NEW.organization_id <> OLD.organization_id OR NEW.number <> OLD.number THEN
    RAISE EXCEPTION 'incident organization and number are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'triggered'     AND NEW.status IN ('acknowledged', 'investigating', 'resolved')) OR
       (OLD.status = 'acknowledged'  AND NEW.status IN ('investigating', 'mitigated', 'resolved')) OR
       (OLD.status = 'investigating' AND NEW.status IN ('mitigated', 'resolved')) OR
       (OLD.status = 'mitigated'     AND NEW.status IN ('investigating', 'resolved')) OR
       (OLD.status = 'resolved'      AND NEW.status IN ('investigating'))
     ) THEN
    RAISE EXCEPTION 'invalid incident status transition % -> %', OLD.status, NEW.status USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER incidents_before_update
  BEFORE UPDATE ON incidents
  FOR EACH ROW EXECUTE FUNCTION incidents_before_update();

-- ---------------------------------------------------------------------------------------------
-- Timeline: append-only audit trail of everything that happens to an incident.
-- actor_id has no foreign key on purpose: history must not change when a user is deleted, so the display
-- name at the time is stored in actor_label.
CREATE TABLE incident_events (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid        NOT NULL,
  incident_id     uuid        NOT NULL,
  type            text        NOT NULL,
  actor_id        uuid,
  actor_label     text        NOT NULL DEFAULT 'system',
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_events_incident_fkey
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT incident_events_type_valid CHECK (type IN
    ('created', 'status_changed', 'assigned', 'severity_changed', 'edited', 'comment')),
  CONSTRAINT incident_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT incident_events_payload_size CHECK (pg_column_size(payload) <= 20000),
  CONSTRAINT incident_events_actor_label_length CHECK (char_length(actor_label) BETWEEN 1 AND 80)
);

CREATE INDEX incident_events_incident_idx ON incident_events (organization_id, incident_id, id);

CREATE FUNCTION incident_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Deleting an organization (or incident) cascades into this table through a foreign-key trigger, which
  -- runs this trigger at depth >= 2. A direct DELETE or any UPDATE runs at depth 1 and is refused.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'incident_events is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER incident_events_no_update_delete
  BEFORE UPDATE OR DELETE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION incident_events_append_only();

CREATE FUNCTION incident_events_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'incident_events is append-only (TRUNCATE refused)' USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER incident_events_no_truncate
  BEFORE TRUNCATE ON incident_events
  FOR EACH STATEMENT EXECUTE FUNCTION incident_events_no_truncate();

-- ---------------------------------------------------------------------------------------------
-- Invitations: an admin creates one, the invitee redeems the token while logged in. No email is sent by the
-- platform in this version; the admin shares the link. Bound to an email address and single-use.
-- Owners cannot be created by invitation (ownership is granted by an existing owner changing a role).
CREATE TABLE organization_invites (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  email           text        NOT NULL,
  role            text        NOT NULL,
  token_hash      text        NOT NULL,
  created_by      uuid        REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  accepted_at     timestamptz,
  accepted_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  CONSTRAINT organization_invites_token_hash_key UNIQUE (token_hash),
  CONSTRAINT organization_invites_token_hash_format CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT organization_invites_email_normalised CHECK (email = lower(btrim(email)) AND char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT organization_invites_role_valid CHECK (role IN ('viewer', 'responder', 'admin')),
  CONSTRAINT organization_invites_expiry CHECK (expires_at > created_at),
  CONSTRAINT organization_invites_not_both CHECK (NOT (accepted_at IS NOT NULL AND revoked_at IS NOT NULL))
);

CREATE INDEX organization_invites_org_idx ON organization_invites (organization_id, created_at DESC);
