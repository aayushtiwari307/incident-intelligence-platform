# Portable handoff — Incident Intelligence Platform

Read `PROJECT_MEMORY.md` first, then inspect source. Actual command output and GitHub/browser evidence outrank stale notes. Never claim an unrun check passed; never weaken tests; preserve upstream MIT attribution, security invariants and applied migrations. Do not package `.env`, `node_modules`, generated build output or `.git`.

## Current closeout state (2026-11-05)

- M1–M10 implementation is substantially complete; M1–M5 are complete. Historical unaccepted/implementation-only labels are preserved below only where they date original evidence.
- M6: deployed on Render Free + Neon. A future live check must recheck landing and health endpoints rather than treating older 200 responses as current proof.
- M7: Alertmanager implementation is merged. Synthetic scenarios passed 8/8, and on 2026-11-03 an official local Alertmanager container sent a genuine notification to Render and created Incident #6. Temporary credentials and the local test container were cleaned up.
- M8: similar incident retrieval is implemented without AI. Preserve historical retrieval, integration and browser evidence; do not claim production or live workflow completeness beyond recorded evidence.
- M9: Gemini grounded-suggestions adapter is implemented and locally verified. On 2026-11-05, one live synthetic incident request succeeded with `gemini-3.5-flash-lite` (INC-0001); local API tests, typecheck and build passed as recorded in `PROJECT_MEMORY.md`. Legacy AI analysis remains unavailable for Gemini. Render remains unconfigured and AI disabled there pending explicit owner approval.
- GitHub issue/PR enrichment is implemented. Live successful retrieval is unverified; the prior live attempt returned `rate_limited`.
- M10: event `live-check-001` appeared on Incident #3 and remained visible after refresh; service-link persistence is verified. Correlation is not proof of causation.
- Previously reported final-tree verification: CI green, 537 unit tests, 271 integration tests, smoke 20/20, and zero audit vulnerabilities. These are reported results, not evidence for any unlisted live workflow.
- Previously reported live page loading: login, Services and GitHub pages loaded successfully. Live health endpoints and targeted Services/GitHub workflows still need fresh rechecking.
- Realtime was verified with two tabs, same browser session. This is the final evidence label; no independent-browser test will be done.
- Backup/restore and health checks are complete. The Control Room redesign is pushed and deployed to Render; the owner approved the visual refinement. Package metadata, MIT LICENSE and README are complete.
- Backup/restore requires a drill on disposable local PostgreSQL only.

## Remaining work

1. Confirm service-link persistence and complete change-event correlation.
2. Obtain successful live GitHub retrieval evidence.
3. Recheck live health endpoints and targeted Services/GitHub workflows.
4. Complete actual two-browser realtime verification only after direct database wiring and owner approval.
5. Perform the local disposable-PostgreSQL backup/restore drill.
6. Test the actual external Alertmanager sender.
7. Add README screenshots and the live URL; choose the project name and license; add a root LICENSE while preserving upstream `julmtoz` attribution.
8. After explicit owner approval, optionally configure Gemini on Render and verify one synthetic suggestion. Keep Render AI disabled until then; never send confidential, customer or production incident data through the Free tier.
9. Control Room redesign is implemented and deployed to Render (commit `3ba656f`, auto-deploy config `95a3413`); the user confirmed the approved local visual refinement.

## Current source and status
- **Accepted Milestone 2.1:** `incident-platform-milestone2.1-windows-verified.zip` (fallback baseline).
- **Accepted Milestone 3:** GitHub commit `8e0a1d3` on `main`, repository `https://github.com/aayushtiwari307/incident-intelligence-platform`.
- **Milestone 3 evidence, user-confirmed on Windows:** 189 unit/repository tests; 121/121 PostgreSQL integration tests across 10 suites; typecheck/lint/build passed; Docker images built and stack healthy; five migrations applied, none pending; non-root checks passed; actual container smoke 14/14; browser login → create incident `#1 Milestone 3 Browser Verification` → F5 persistence → comment visible in timeline. The user then confirmed the GitHub Actions run was green; exact run URL was not captured here. Treat that CI confirmation as user-reported evidence. Do not repeat these checks without a specific reason.

## Milestone 5 (implemented, NOT accepted) — 2026-10-14
M4 was merged by the maintainer (maintainer-reported); its lockfile contains `socket.io@4.8.4`/`socket.io-client@4.8.4`, so the older "lockfile needs regeneration" notes below are stale. M5 adds, in source only: optional `REDIS_URL`, `ioredis` and the Compose Redis service removed, WebSocket checks in `smoke:stack` and CI (with a negative control), an optional Caddy single-origin topology, trust-proxy integration tests, session verification after login/register, and audit/verification docs. The fresh 2026-10-24 local run passed the workspace Jest suites, typecheck, ESLint, API build, and Next.js build; the 257-test integration run also passed its real-time API suites. These local checks do not establish deployed real-time acceptance. The deployed service still has real-time disabled, and the manual two-browser live-update check remains UNVERIFIED. The older testing statement above is historical.

## Milestone 4 (history; merged per maintainer)
Socket.IO real-time incident updates are implemented in `apps/api/src/realtime/`, shared protocol in `packages/shared/src/realtime.ts`, web client/hook in `apps/web/src/lib/`, with migration `0006_incident_events_notify.sql`. The fresh local run passed API real-time integration tests and web real-time unit tests; it does not prove the deployed two-browser experience. Real-time remains disabled in the public service, so that acceptance test is still pending. Historical M4-candidate note: the earlier candidate needed lockfile regeneration at that time. The current checkout passed typecheck, lint, unit/integration tests, and API/web builds on 2026-10-24. Do not apply the old candidate instruction without fresh evidence of a current lockfile problem.

Remaining real-time acceptance: after M6 closeout, investigate the direct Neon listener connection and free-tier sleep/reconnect behavior. Accept real-time only after two browsers see a live update on the deployed URL. Keep it disabled until that verification and an explicit deployment decision.

## Invariants
- Tenant derived from authenticated membership; cross-tenant reads are 404; server-side role checks.
- Secure/revocable sessions, CSRF/Origin allow-list, invitations hashed/single-use, minimum one organization owner.
- State transitions constrained in service and DB; optimistic concurrency 409; append-only incident timeline and audit trail.
- PostgreSQL durable queue (not Redis/BullMQ) with transactionally enqueued jobs, retries, lease fencing and poisoned-job isolation.
- AI is optional/advisory; human applies suggestions through the audited API. Gemini is live-verified locally for M9 grounded suggestions using one synthetic incident; legacy analysis remains unavailable for Gemini, and Render has not been configured.
- Realtime client never selects organization/room; handshake checks session cookie + browser Origin; only organization-filtered messages are broadcast; revocation/access re-check and resync must fail closed.
- Never run `npm run services:reset`. It deletes Compose volumes. Preserve existing data and use isolated M4 containers/database.

## Local Windows notes
Project path currently used for accepted M3: `C:\Users\Aayush Tiwari\Downloads\incident-platform-milestone3 (1)\incident-platform`. Local ports commonly used: Postgres 5434, (Redis 6380 until M5 removed the service), API 3001, web 3000; conflicts occurred, so use an isolated Compose project and alternate host ports if needed. Keep `.env` values private. Browse consistently at `http://127.0.0.1:3000`, not `localhost`.

## Handoff update (2026-10-14): invitation flow

- Current branch: `main`, based on the fetched `origin/main` commit.
- The current local changes include Team invitation copy controls, future-aware relative-time formatting plus a test, and the M5 PostgreSQL port mapping `127.0.0.1:5545:5432`.
- Local verification confirmed database reachability on 5545, API startup on 3001, and Next.js startup on 3000.
- Direct API invitation acceptance succeeded with HTTP 200 after the raw token was extracted from the registration URL fragment. The full URL is not a valid `token` request value. Browser acceptance was not separately retested.
- The test Viewer account now has a `viewer` membership in the Test Owner organization and still retains its own organization membership as owner.
- To restore the older M3 web container later, first stop the M5 frontend with Ctrl+C, then run `docker start incident-platform-m3-web-1`. The container was stopped, not deleted.
- Never commit `.env`, `*.bak`, `npm-audit-report.json`, credentials, or invite tokens. Continue to the next milestone after the M5 verification update is pushed.

## Handoff update (2026-10-16): Milestone 7 candidate review (historical; superseded by current status)
This section preserves the pre-merge 2026-10-16 candidate review as history only. Current status: M7 is merged and included in the deployed application; real external Alertmanager integration remains untested, and rate limiting is in-memory per process. See `docs/decisions/0018-alertmanager-ingestion.md`, `docs/integrations/alertmanager.md`, and `docs/verification/milestone-7-status.md`. Do not use the historical migration/test status as current deployment evidence.
