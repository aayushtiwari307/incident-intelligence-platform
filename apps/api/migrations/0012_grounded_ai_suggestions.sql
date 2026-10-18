-- 0012_grounded_ai_suggestions: per-organization AI opt-in, an atomic daily quota, an append-only AI audit trail and
-- grounded AI suggestions (Milestone 9).
--
-- Design rules enforced HERE, not only in application code:
--   * AI is OFF for an organization until an owner/admin turns it on (no row = off); the switch records who changed it
--   * the daily quota is ONE row per (organization, UTC day); the application reserves with a single conditional upsert
--     (see ai/suggestion-quota.ts), and the CHECK keeps the counter inside a hard ceiling even if code is wrong
--   * a suggestion belongs to an incident of its own organization (composite FK, cascade on delete)
--   * at most ONE suggestion per incident is queued/running (partial unique index): double clicks cannot stack provider calls
--   * a stored suggestion has validated content exactly when it is pending/applied/dismissed, an error code exactly when
--     failed, and a quota refund is only possible for a failed suggestion whose provider was never called (refund once)
--   * the AI audit trail is append-only (like incident_events) and never holds model text

CREATE TABLE organization_ai_settings (
  organization_id     uuid        PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  suggestions_enabled boolean     NOT NULL DEFAULT false,
  updated_by          uuid        REFERENCES users (id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_ai_usage (
  organization_id uuid    NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  usage_date      date    NOT NULL,
  requests_used   integer NOT NULL DEFAULT 0,
  PRIMARY KEY (organization_id, usage_date),
  CONSTRAINT organization_ai_usage_range CHECK (requests_used BETWEEN 0 AND 100000)
);

CREATE TABLE ai_suggestions (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL,
  incident_id           uuid        NOT NULL,
  requested_by          uuid        REFERENCES users (id) ON DELETE SET NULL,
  incident_version      integer     NOT NULL CHECK (incident_version >= 1),
  status                text        NOT NULL DEFAULT 'queued',
  job_id                uuid,
  model                 text,
  prompt_version        text,
  content               jsonb,
  error_code            text,
  -- The day whose quota this request used (so a refund always hits the right day, even after midnight UTC).
  quota_date            date        NOT NULL,
  -- Set right before the provider is first called. A request that never reached the provider is refunded.
  provider_attempted_at timestamptz,
  quota_refunded        boolean     NOT NULL DEFAULT false,
  input_tokens          integer,
  output_tokens         integer,
  applied_target        text,
  reviewed_by           uuid        REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  CONSTRAINT ai_suggestions_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT ai_suggestions_incident_fkey
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_suggestions_job_fkey
    FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE SET NULL (job_id),
  CONSTRAINT ai_suggestions_status_valid CHECK (status IN ('queued', 'running', 'pending', 'applied', 'dismissed', 'failed')),
  CONSTRAINT ai_suggestions_error_code_valid CHECK (
    error_code IS NULL OR error_code IN ('provider_error', 'invalid_output', 'timeout', 'incident_missing', 'gate_closed')
  ),
  CONSTRAINT ai_suggestions_target_valid CHECK (applied_target IS NULL OR applied_target IN ('severity', 'comment')),
  CONSTRAINT ai_suggestions_text_bounds CHECK (
    (model IS NULL OR char_length(model) <= 100) AND (prompt_version IS NULL OR char_length(prompt_version) <= 60)
  ),
  CONSTRAINT ai_suggestions_tokens_bounds CHECK (
    (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 100000000) AND (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 100000000)
  ),
  CONSTRAINT ai_suggestions_content_object CHECK (content IS NULL OR (jsonb_typeof(content) = 'object' AND pg_column_size(content) <= 32768)),
  CONSTRAINT ai_suggestions_content_consistent CHECK ((status IN ('pending', 'applied', 'dismissed')) = (content IS NOT NULL)),
  CONSTRAINT ai_suggestions_failed_has_code CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT ai_suggestions_finished_consistent CHECK ((status IN ('queued', 'running')) = (completed_at IS NULL)),
  CONSTRAINT ai_suggestions_applied_consistent CHECK ((status = 'applied') = (applied_target IS NOT NULL)),
  CONSTRAINT ai_suggestions_reviewed_consistent CHECK ((status IN ('applied', 'dismissed')) = (reviewed_at IS NOT NULL)),
  CONSTRAINT ai_suggestions_refund_consistent CHECK (NOT quota_refunded OR (status = 'failed' AND provider_attempted_at IS NULL))
);

-- One generation in flight per incident (organization is implied by the incident id, which is globally unique).
CREATE UNIQUE INDEX ai_suggestions_one_active_idx ON ai_suggestions (incident_id) WHERE status IN ('queued', 'running');
CREATE INDEX ai_suggestions_incident_idx ON ai_suggestions (organization_id, incident_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------------------------
-- AI audit trail. Append-only, organization-scoped, optionally tied to an incident. The payload holds identifiers,
-- enums and booleans only: never incident text, prompts or model output.
CREATE TABLE ai_audit_events (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  incident_id     uuid,
  suggestion_id   uuid,
  type            text        NOT NULL,
  -- No foreign key on purpose (history must not change when a user is deleted); the display name is kept in actor_label.
  actor_id        uuid,
  actor_label     text        NOT NULL DEFAULT 'system',
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ai_audit_events_incident_fkey
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT ai_audit_events_type_valid CHECK (type IN
    ('ai_settings_changed', 'suggestion_requested', 'suggestion_applied', 'suggestion_dismissed')),
  CONSTRAINT ai_audit_events_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT ai_audit_events_payload_size CHECK (pg_column_size(payload) <= 2000),
  CONSTRAINT ai_audit_events_actor_label_length CHECK (char_length(actor_label) BETWEEN 1 AND 80)
);

CREATE INDEX ai_audit_events_org_idx ON ai_audit_events (organization_id, id);

CREATE FUNCTION ai_audit_events_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Deleting an organization (or incident) cascades into this table through a foreign-key trigger at depth >= 2.
  -- A direct DELETE or any UPDATE runs at depth 1 and is refused.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'ai_audit_events is append-only (% refused)', TG_OP USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER ai_audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON ai_audit_events
  FOR EACH ROW EXECUTE FUNCTION ai_audit_events_append_only();

CREATE FUNCTION ai_audit_events_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ai_audit_events is append-only (TRUNCATE refused)' USING ERRCODE = '42501';
END
$$;

CREATE TRIGGER ai_audit_events_no_truncate
  BEFORE TRUNCATE ON ai_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION ai_audit_events_no_truncate();
