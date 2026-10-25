# Incident Intelligence Platform — Coding Completion Report

**Date:** 2026-10-25
**Baseline:** the owner-provided `IIP-Step1-Verified-Source-20261025-021857(1).zip`.
**Status:** substantial coding implementation is present in this archive; **full final-tree acceptance remains pending**. Nothing was committed, pushed, merged, deployed or run against production Neon.

## Summary

The verified Step 1 baseline was used as the foundation. The work integrated GitHub issue/PR enrichment, M10 service/change context, selected registration/realtime safeguards, operational safety scripts, and reconciled documentation. Additional review hardened remote-text/timestamp parsing, shared GitHub quota enforcement, cached snapshot projection, service change timestamp validation, and service-link transaction handling. A second inspection found and fixed two integration edge cases: Alertmanager service labels were consumed without being present in the parsed-alert projection, and a GitHub `304 Not Modified` response could not recover when the cached issue snapshot was missing or invalid.

The project is not labelled production-ready. The complete integrated TypeScript/Jest suites, semantic typecheck, ESLint, builds and PostgreSQL-backed tests could not be rerun in the authoring container because `npm ci` stalled on registry DNS failures (`EAI_AGAIN registry.npmjs.org`). Those tests are required before release. There was no live GitHub request or production database operation.

## Main implementation delivered

### GitHub issue/PR enrichment

- Migration `0013_github_issue_enrichment.sql` adds per-organization opt-in settings, repository allow-listing, and a bounded cached issue/PR link.
- API settings and incident link/context endpoints are integrated through the existing session/auth/authorization patterns.
- GitHub endpoints are built only against `https://api.github.com` from schema-validated owner/repo/issue identifiers. Redirects are manual, timeouts and response byte limits are enforced, ETags are used, and no GitHub token is accepted, stored, logged or returned.
- Cache refreshes for a link are coalesced; private/404 results clear snapshots and ETags; failed comments refreshes do not incorrectly imply all enrichment is healthy.
- `GitHubBudget` observes rate-limit headers/Retry-After, reserves quota, and has a bounded circuit breaker. Existing per-organization and 50-request/hour process caps remain.
- External text is control/bidi-cleaned and bounded before caching/rendering. Cached snapshots are revalidated before return, malformed remote timestamps are discarded, and a `304` with no valid cached issue triggers one unconditional recovery request.
- UI provides repository settings and an incident enrichment panel with useful status/error states. Unit and UI tests are present but not executed in this container. Review follow-up added a regression test for recovering an issue when GitHub returns `304` but there is no valid cached representation.

### M10 service catalog and change context

- Migration `0014_service_change_context.sql` adds service records, incident service links, change events, idempotency and timeline event type constraints.
- Service management and incident/service link APIs are tenant-scoped and require the existing integration-management or incident-update permissions.
- Change-event credentials are separate from Alertmanager credentials and stored as hashes. Ingestion validates payloads, bounds rate, deduplicates by organization/source/external ID, and touches `last_used_at` only best-effort after commit.
- Timestamp handling now checks RFC 3339 syntax, actual calendar dates, time/offset fields, 30-day age and five-minute future-skew limits. It rejects `Date.parse` calendar normalization and the unknown `-00:00` offset.
- Correlation is bounded to the previous 24 hours for the same organization/service and is explicitly labelled “correlation, not proven cause”. A matching change adds an existing incident timeline wake-up record.
- Alertmanager `service` labels are now projected as a bounded optional service name; same-organization catalog matching is performed before insert, so automatic linking does not cause an unintended incident version bump. Service deletion is refused while audit/history or incidents still reference the service. Parent/service row locking follows one consistent order to avoid known delete/link deadlock races.
- Service catalog and incident context panels, change simulator, and Jest integration tests are present. Regression coverage also verifies Alertmanager service-label projection and that auto-linking leaves a newly created incident at version 1. Migrations and new PostgreSQL tests have not been run in this authoring environment.

### Registration, realtime, and Stage 5

- The API exposes a read-only registration-policy endpoint; production public registration is configurable and defaults off in production, while valid invite registration remains separate. The registration page consults the API rather than relying solely on build-time `NODE_ENV`. Current Render behavior has not been checked.
- `REALTIME_DATABASE_URL` is required explicitly when realtime is enabled; it does not fall back to `DATABASE_URL`. Realtime defaults off, obvious pooler endpoints are rejected, and the Dockerfile has a build argument for the public browser switch.
- Added read-only public realtime smoke checks, loopback integration-test DB guards, safe backup/restore scripts, a loopback change-event simulator, deployment guidance and refreshed handoff docs.
- Database backup/restore was not run as part of this code integration. No migrations were applied here.

## Dependency and historical baseline evidence

The owner provided Windows output from the preceding Step 1 working copy showing a clean `npm ci`, installed `multer@2.5.0`, `zod@4.6.7`, `body-parser@2.4.0`, and `npm audit` with 0 vulnerabilities. That same pre-integration working copy passed typecheck, lint, the API (273) and web (75) unit tests, 258 PostgreSQL integration tests, and production build. The integrated features were added afterward; therefore these results are historical baseline evidence, not full-final-tree verification. Dependency manifests/lockfile were not changed while integrating GitHub/M10 code, but a fresh full-tree audit should still be run after installation.

## Verification log for this final archive

| Check | Result | Evidence boundary |
|---|---|---|
| `node --test "scripts/*.test.mjs"` | **82 passed, 0 failed** | Run in this container on final source; root JavaScript tests only |
| Pure logic assertions (change timestamps/windows, GitHub budget/circuit breaker, remote text, bucket) | **16 passed** | Run using the globally available TypeScript transpiler; targeted checks only, not Jest |
| TypeScript syntax parsing | **185 TypeScript/TSX source and declaration files, 0 syntax diagnostics** | Parse-only, not semantic typecheck |
| Repository hygiene scan (source-tree fallback without `.git`) | **319 files scanned, no findings** | Source-tree scan excludes generated directories; hygiene script also has unit-test coverage for ZIP fallback |
| `npm ci` in this authoring container | **Blocked** | npm registry returned `EAI_AGAIN registry.npmjs.org`; partial `node_modules` removed before packaging |
| Full workspace Jest unit suite | **Not run on final archive** | Dependencies unavailable in this container |
| Semantic typecheck and ESLint | **Not run on final archive** | Dependencies unavailable in this container |
| API/web production builds | **Not run on final archive** | Dependencies unavailable in this container |
| PostgreSQL migrations `0013`/`0014` and integration suite | **Not run on final archive** | No PostgreSQL/Docker service available in this container; do this only against disposable local PostgreSQL |
| Live GitHub, realtime/two-browser, registration, Alertmanager and Render acceptance | **Not run** | Requires account/runtime settings; no live request or deployment performed |

## Remaining work before release

1. Extract this ZIP to a **new folder** and run `npm ci`; then run `npm audit`, `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, and `npm run check:deps`. Fix any issues from the fully installed/tested tree without weakening tests.
2. Against a disposable local PostgreSQL database only, apply migrations and run `npm run test:integration`, particularly the new tenant-isolation, idempotency, concurrency, timeline, timestamp and GitHub-link tests. Never use production Neon.
3. Exercise backup/restore scripts on an expendable local database, and verify CI/Compose smoke behavior.
4. Only after local checks are green, review and approve the changes, then perform staged deployment, registration-policy acceptance, two-browser realtime checks and any external Alertmanager/GitHub smoke tests.
5. Update this report with the actual results before calling the project accepted.

## Change policy

No GitHub commit/push, PR merge, Render deployment, hosted environment mutation or production database operation was performed. Preserve the original project and the supplied baseline ZIP. Use the separate patch deliverable for review/apply if desired.
