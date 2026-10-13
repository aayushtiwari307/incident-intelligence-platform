-- Spike: can PostgreSQL row-level security carry a tenant id safely through a connection pool?
-- Run:  psql -v ON_ERROR_STOP=1 -f rls-pooling.sql  (as a role that may CREATE DATABASE/ROLE)
-- It only creates a throw-away database and role and drops them at the end.
\set ON_ERROR_STOP on
DROP DATABASE IF EXISTS rls_spike;
CREATE DATABASE rls_spike;
\c rls_spike

CREATE ROLE rls_app NOLOGIN;            -- stands in for the non-superuser role the API would connect as
CREATE TABLE incidents (id int PRIMARY KEY, organization_id uuid NOT NULL, title text NOT NULL);
GRANT SELECT, INSERT, UPDATE, DELETE ON incidents TO rls_app;
INSERT INTO incidents VALUES (1, '00000000-0000-0000-0000-00000000000a', 'org A incident'),
                             (2, '00000000-0000-0000-0000-00000000000b', 'org B incident');
ALTER TABLE incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE incidents FORCE ROW LEVEL SECURITY;    -- applies to the table owner too
CREATE POLICY tenant_isolation ON incidents
  USING      (organization_id = nullif(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (organization_id = nullif(current_setting('app.org_id', true), '')::uuid);

SET ROLE rls_app;

\echo '--- 1. no tenant context set: must see nothing (fail closed)'
SELECT count(*) AS visible_rows FROM incidents;

\echo '--- 2. set_config(..., is_local = true) inside a transaction: sees only org A'
BEGIN;
SELECT set_config('app.org_id', '00000000-0000-0000-0000-00000000000a', true);
SELECT id, title FROM incidents;
COMMIT;

\echo '--- 3. same connection, next transaction: context must be gone (this is what makes pooling safe)'
SELECT current_setting('app.org_id', true) AS leaked_context, (SELECT count(*) FROM incidents) AS visible_rows;

\echo '--- 4. writing a row for another tenant is rejected by WITH CHECK'
BEGIN;
SELECT set_config('app.org_id', '00000000-0000-0000-0000-00000000000a', true);
\set ON_ERROR_STOP off
INSERT INTO incidents VALUES (3, '00000000-0000-0000-0000-00000000000b', 'cross-tenant write');
\set ON_ERROR_STOP on
ROLLBACK;

\echo '--- 5. ANTI-PATTERN: set_config(..., is_local = false) / SET leaks across pooled requests'
SELECT set_config('app.org_id', '00000000-0000-0000-0000-00000000000a', false);
BEGIN; COMMIT;
SELECT count(*) AS still_visible_after_commit FROM incidents;   -- the next request on this connection inherits org A
RESET app.org_id;

\echo '--- 6. superuser/BYPASSRLS roles ignore policies: the API must never connect as one'
RESET ROLE;
SELECT count(*) AS superuser_sees FROM incidents;

\c postgres
DROP DATABASE rls_spike;
DROP ROLE rls_app;
