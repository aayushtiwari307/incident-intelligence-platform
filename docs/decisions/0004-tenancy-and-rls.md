# 0004 Tenant isolation: application-level now, RLS deferred

**Decision.** Authorization is enforced in the API from the start: every query on tenant data takes `organization_id` from the authenticated membership (never from the request body), and role checks use `roleAtLeast`. The frontend never filters for security.

**RLS is deferred, not rejected.** Spike `docs/spikes/rls-pooling.sql` (output: `rls-pooling.output.txt`, real PostgreSQL 16) established:
1. with no tenant context the policy returns 0 rows (fails closed)
2. `set_config('app.org_id', …, true)` is transaction-scoped; after COMMIT the next transaction on the same connection sees no context, which is what makes it safe behind a pool
3. `WITH CHECK` rejects writing a row for another tenant
4. the anti-pattern `set_config(…, false)` / `SET` **leaks** to the next request on the same pooled connection (the spike shows the row still visible after COMMIT)
5. superusers and `BYPASSRLS` roles ignore policies, so the API would need a dedicated non-superuser role and `FORCE ROW LEVEL SECURITY`

**Why still deferred.** The spike proves the database mechanism, not our code path. The requirement was to add RLS only if it can be implemented *and tested* with the real `pg` pool; `pg` could not run in the sandbox, so a pooled request-level test could not be written honestly. Planned for after Phase 2: a `withTenant(orgId, fn)` helper that opens a transaction, sets the local context, runs `fn`, commits, plus a test that interleaves requests of two tenants on a pool of size 1.

**Multi-tenant integrity today:** composite foreign key convention (see 0001) prevents cross-tenant references at the database level.
