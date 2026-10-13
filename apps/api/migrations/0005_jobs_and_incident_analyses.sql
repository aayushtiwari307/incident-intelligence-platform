-- 0005_jobs_and_incident_analyses: a durable PostgreSQL job queue and AI incident analyses.
--
-- The job row is written in the SAME transaction as the thing that needs the work (an incident, a re-run request),
-- so work is never lost between "saved" and "queued" (transactional outbox). Workers claim rows with
-- FOR UPDATE SKIP LOCKED and a lease; a worker that dies simply lets its lease expire.
--
-- Rules enforced here, not only in application code:
--   * a job is 'running' exactly when it has a lease holder and an expiry
--   * at most ONE queued/running analysis per incident (partial unique index)
--   * an analysis belongs to an incident of its own organization (composite FK, cascade on delete)
--   * a completed analysis carries a full, bounded result

CREATE TABLE jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  type            text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  status          text        NOT NULL DEFAULT 'pending',
  attempts        integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 3,
  run_at          timestamptz NOT NULL DEFAULT now(),
  locked_by       text,
  locked_until    timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  CONSTRAINT jobs_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT jobs_type_format CHECK (type ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT jobs_payload_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT jobs_status_valid CHECK (status IN ('pending', 'running', 'succeeded', 'dead')),
  CONSTRAINT jobs_attempts_range CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 20),
  CONSTRAINT jobs_lease_consistent CHECK ((status = 'running') = (locked_by IS NOT NULL AND locked_until IS NOT NULL)),
  CONSTRAINT jobs_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  CONSTRAINT jobs_completed_consistent CHECK ((status IN ('succeeded', 'dead')) = (completed_at IS NOT NULL))
);
-- The claim query scans only rows that can be claimed.
CREATE INDEX jobs_claimable_idx ON jobs (run_at, id) WHERE status = 'pending';
CREATE INDEX jobs_lease_idx ON jobs (locked_until) WHERE status = 'running';

CREATE TABLE incident_analyses (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid        NOT NULL,
  incident_id      uuid        NOT NULL,
  status           text        NOT NULL DEFAULT 'queued',
  job_id           uuid,
  requested_by     uuid        REFERENCES users (id) ON DELETE SET NULL,
  incident_version integer     NOT NULL CHECK (incident_version >= 1),
  model            text,
  suggested_severity text,
  category         text,
  summary          text,
  probable_cause   text,
  steps            jsonb,
  error_code       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT incident_analyses_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT incident_analyses_incident_fkey
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT incident_analyses_job_fkey
    FOREIGN KEY (organization_id, job_id) REFERENCES jobs (organization_id, id) ON DELETE SET NULL (job_id),
  CONSTRAINT incident_analyses_status_valid CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  CONSTRAINT incident_analyses_severity_valid CHECK (suggested_severity IS NULL OR suggested_severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
  CONSTRAINT incident_analyses_error_code_valid CHECK (error_code IS NULL OR error_code IN ('provider_error', 'invalid_output', 'timeout', 'incident_missing')),
  CONSTRAINT incident_analyses_text_bounds CHECK (
    (category IS NULL OR char_length(category) BETWEEN 1 AND 80)
    AND (summary IS NULL OR char_length(summary) <= 2000)
    AND (probable_cause IS NULL OR char_length(probable_cause) <= 2000)
    AND (model IS NULL OR char_length(model) <= 100)
  ),
  CONSTRAINT incident_analyses_steps_bounds CHECK (steps IS NULL OR (jsonb_typeof(steps) = 'array' AND jsonb_array_length(steps) <= 10)),
  CONSTRAINT incident_analyses_completed_has_result CHECK (
    status <> 'completed' OR (suggested_severity IS NOT NULL AND category IS NOT NULL AND summary IS NOT NULL AND steps IS NOT NULL)
  ),
  CONSTRAINT incident_analyses_failed_has_code CHECK ((status = 'failed') = (error_code IS NOT NULL)),
  CONSTRAINT incident_analyses_finished_consistent CHECK ((status IN ('completed', 'failed')) = (completed_at IS NOT NULL))
);
-- Only one analysis may be in flight per incident: concurrent "re-run" clicks cannot stack up provider calls.
CREATE UNIQUE INDEX incident_analyses_one_active_idx ON incident_analyses (incident_id) WHERE status IN ('queued', 'running');
CREATE INDEX incident_analyses_incident_idx ON incident_analyses (organization_id, incident_id, created_at DESC);
