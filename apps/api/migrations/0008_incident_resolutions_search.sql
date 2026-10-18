-- 0008_incident_resolutions_search: tenant-safe current resolutions and derived full-text documents.

CREATE TABLE IF NOT EXISTS incident_resolutions (
  organization_id uuid        NOT NULL,
  incident_id     uuid        NOT NULL,
  root_cause      text        NOT NULL,
  fix_applied     text        NOT NULL,
  resolved_by     uuid,
  version         integer     NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_resolutions_pkey PRIMARY KEY (organization_id, incident_id),
  CONSTRAINT incident_resolutions_incident_fkey
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT incident_resolutions_resolver_fkey
    FOREIGN KEY (organization_id, resolved_by) REFERENCES memberships (organization_id, user_id)
    ON DELETE SET NULL (resolved_by),
  CONSTRAINT incident_resolutions_root_cause_length CHECK (char_length(btrim(root_cause)) BETWEEN 1 AND 2000),
  CONSTRAINT incident_resolutions_fix_applied_length CHECK (char_length(btrim(fix_applied)) BETWEEN 1 AND 2000),
  CONSTRAINT incident_resolutions_version_positive CHECK (version >= 1),
  CONSTRAINT incident_resolutions_timestamps_valid CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS incident_resolutions_resolved_by_idx
  ON incident_resolutions (organization_id, resolved_by) WHERE resolved_by IS NOT NULL;

CREATE TABLE IF NOT EXISTS incident_search_documents (
  organization_id uuid     NOT NULL,
  incident_id     uuid     NOT NULL,
  search_vector    tsvector NOT NULL,
  CONSTRAINT incident_search_documents_pkey PRIMARY KEY (organization_id, incident_id),
  CONSTRAINT incident_search_documents_incident_fkey
    FOREIGN KEY (organization_id, incident_id) REFERENCES incidents (organization_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incident_search_documents_vector_idx
  ON incident_search_documents USING gin (search_vector);

CREATE OR REPLACE FUNCTION build_incident_search_vector(
  p_title text,
  p_description text,
  p_root_cause text,
  p_fix_applied text
) RETURNS tsvector
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT
    setweight(to_tsvector('english'::regconfig, coalesce(p_title, '')), 'A') ||
    setweight(to_tsvector('english'::regconfig, coalesce(p_description, '')), 'B') ||
    setweight(to_tsvector('english'::regconfig, coalesce(p_root_cause, '')), 'C') ||
    setweight(to_tsvector('english'::regconfig, coalesce(p_fix_applied, '')), 'C')
$$;

CREATE OR REPLACE FUNCTION refresh_incident_search_document(p_organization_id uuid, p_incident_id uuid)
RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'incident search refresh requires READ COMMITTED isolation (current: %)',
      current_setting('transaction_isolation')
      USING ERRCODE = '0A000';
  END IF;
  -- Serialize source reads and document upserts for one incident. The source SELECT after this
  -- lock sees commits made while waiting under READ COMMITTED. Transactions changing multiple
  -- incidents should acquire incident locks in a stable order; PostgreSQL detects and aborts any
  -- lock-order deadlock.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_organization_id::text || ':' || p_incident_id::text, 0));
  INSERT INTO incident_search_documents (organization_id, incident_id, search_vector)
  SELECT
    i.organization_id,
    i.id,
    build_incident_search_vector(i.title, i.description, r.root_cause, r.fix_applied)
  FROM incidents i
  LEFT JOIN incident_resolutions r
    ON r.organization_id = i.organization_id AND r.incident_id = i.id
  WHERE i.organization_id = p_organization_id AND i.id = p_incident_id
  ON CONFLICT (organization_id, incident_id)
    DO UPDATE SET search_vector = EXCLUDED.search_vector;
END
$$;

CREATE OR REPLACE FUNCTION incident_resolutions_before_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id <> OLD.organization_id OR NEW.incident_id <> OLD.incident_id THEN
    RAISE EXCEPTION 'incident resolution organization and incident are immutable' USING ERRCODE = '23514';
  END IF;
  NEW.version := OLD.version + 1;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS incident_resolutions_before_update ON incident_resolutions;
CREATE TRIGGER incident_resolutions_before_update
  BEFORE UPDATE ON incident_resolutions
  FOR EACH ROW EXECUTE FUNCTION incident_resolutions_before_update();

CREATE OR REPLACE FUNCTION incidents_refresh_search_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM refresh_incident_search_document(NEW.organization_id, NEW.id);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS incidents_refresh_search_document_after_write ON incidents;
CREATE TRIGGER incidents_refresh_search_document_after_write
  AFTER INSERT OR UPDATE OF title, description ON incidents
  FOR EACH ROW EXECUTE FUNCTION incidents_refresh_search_document();

CREATE OR REPLACE FUNCTION incident_resolutions_refresh_search_document() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
    PERFORM refresh_incident_search_document(OLD.organization_id, OLD.incident_id);
    RETURN OLD;
  END IF;
  PERFORM refresh_incident_search_document(NEW.organization_id, NEW.incident_id);
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS incident_resolutions_refresh_search_document_after_write ON incident_resolutions;
CREATE TRIGGER incident_resolutions_refresh_search_document_after_write
  AFTER INSERT OR UPDATE OR DELETE ON incident_resolutions
  FOR EACH ROW EXECUTE FUNCTION incident_resolutions_refresh_search_document();

-- Backfill every existing incident. Re-running this is safe and does not create resolutions.
INSERT INTO incident_search_documents (organization_id, incident_id, search_vector)
SELECT
  i.organization_id,
  i.id,
  build_incident_search_vector(i.title, i.description, r.root_cause, r.fix_applied)
FROM incidents i
LEFT JOIN incident_resolutions r
  ON r.organization_id = i.organization_id AND r.incident_id = i.id
ON CONFLICT (organization_id, incident_id)
  DO UPDATE SET search_vector = EXCLUDED.search_vector;
