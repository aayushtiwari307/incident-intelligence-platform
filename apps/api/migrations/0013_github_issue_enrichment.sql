-- 0013_github_issue_enrichment: tenant opt-in and bounded server-side cache of public GitHub issue/PR context.
-- Repository identifiers are normalized strings, never client-controlled URLs; no GitHub token is stored.

CREATE TABLE organization_github_settings (
  organization_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
  enabled         boolean NOT NULL DEFAULT false,
  updated_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE github_repositories (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  owner           text NOT NULL,
  repo            text NOT NULL,
  linked_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_repositories_org_id_key UNIQUE (organization_id, id),
  CONSTRAINT github_repositories_owner_valid CHECK (owner ~ '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$'),
  CONSTRAINT github_repositories_repo_valid CHECK (repo ~ '^[A-Za-z0-9_.-]{1,100}$' AND repo NOT IN ('.', '..'))
);
CREATE UNIQUE INDEX github_repositories_org_name_key ON github_repositories (organization_id, lower(owner), lower(repo));
CREATE INDEX github_repositories_org_idx ON github_repositories (organization_id, lower(owner), lower(repo));

CREATE TABLE github_issue_links (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid NOT NULL,
  incident_id       uuid NOT NULL,
  repository_id     uuid NOT NULL,
  issue_number      integer NOT NULL,
  issue_etag        text,
  comments_etag     text,
  issue_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  comments_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at        timestamptz,
  refresh_after     timestamptz NOT NULL DEFAULT now(),
  failure_code      text,
  linked_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT github_issue_links_incident_key UNIQUE (organization_id, incident_id),
  CONSTRAINT github_issue_links_incident_fkey FOREIGN KEY (organization_id, incident_id)
    REFERENCES incidents (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT github_issue_links_repository_fkey FOREIGN KEY (organization_id, repository_id)
    REFERENCES github_repositories (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT github_issue_links_number_positive CHECK (issue_number BETWEEN 1 AND 2147483647),
  CONSTRAINT github_issue_links_etag_length CHECK ((issue_etag IS NULL OR char_length(issue_etag) <= 512) AND (comments_etag IS NULL OR char_length(comments_etag) <= 512)),
  CONSTRAINT github_issue_links_snapshots CHECK (jsonb_typeof(issue_snapshot) = 'object' AND jsonb_typeof(comments_snapshot) = 'array'),
  CONSTRAINT github_issue_links_snapshot_size CHECK (pg_column_size(issue_snapshot) <= 30000 AND pg_column_size(comments_snapshot) <= 30000),
  CONSTRAINT github_issue_links_failure_code CHECK (failure_code IS NULL OR failure_code IN ('not_found_or_private', 'rate_limited', 'unavailable', 'invalid_response'))
);
CREATE INDEX github_issue_links_org_refresh_idx ON github_issue_links (organization_id, refresh_after);
