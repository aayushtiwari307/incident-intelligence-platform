# Portable handoff — Incident Intelligence Platform (2026-10-14)

Read `PROJECT_MEMORY.md` first, then inspect source. Actual command output and GitHub/browser evidence outrank stale notes. Never claim an unrun check passed; never weaken tests; preserve upstream MIT attribution, security invariants and applied migrations. Do not package `.env`, `node_modules`, generated build output or `.git`.

## Current source and status
- **Accepted Milestone 2.1:** `incident-platform-milestone2.1-windows-verified.zip` (fallback baseline).
- **Accepted Milestone 3:** GitHub commit `8e0a1d3` on `main`, repository `https://github.com/aayushtiwari307/incident-intelligence-platform`.
- **Milestone 3 evidence, user-confirmed on Windows:** 189 unit/repository tests; 121/121 PostgreSQL integration tests across 10 suites; typecheck/lint/build passed; Docker images built and stack healthy; five migrations applied, none pending; non-root checks passed; actual container smoke 14/14; browser login → create incident `#1 Milestone 3 Browser Verification` → F5 persistence → comment visible in timeline. The user then confirmed the GitHub Actions run was green; exact run URL was not captured here. Treat that CI confirmation as user-reported evidence. Do not repeat these checks without a specific reason.

## Milestone 5 (implemented, NOT accepted) — 2026-10-14
M4 was merged by the maintainer (maintainer-reported); its lockfile contains `socket.io@4.8.4`/`socket.io-client@4.8.4`, so the older "lockfile needs regeneration" notes below are stale. M5 adds, in source only: optional `REDIS_URL`, `ioredis` and the Compose Redis service removed, WebSocket checks in `smoke:stack` and CI (with a negative control), an optional Caddy single-origin topology, trust-proxy integration tests, session verification after login/register, and audit/verification docs. Nothing M5 added has run under Jest, Docker, CI or a browser. Read `docs/verification/milestone-5-status.md` for what was reproduced vs stand-in vs blocked, and `docs/security/npm-audit-m5.md` (R7 is BLOCKED). The manual two-browser check is UNVERIFIED. Run the PowerShell block from the M5 report before accepting.

## Milestone 4 (history; merged per maintainer)
Socket.IO real-time incident updates are implemented in `apps/api/src/realtime/`, shared protocol in `packages/shared/src/realtime.ts`, web client/hook in `apps/web/src/lib/`, with migration `0006_incident_events_notify.sql`. Real socket runtime, migration trigger, the 33 new PostgreSQL integration tests, Jest/Next/ESLint/Docker/CI and two-window browser behavior have not yet been verified. The candidate previously pinned Socket.IO 4.8.1; reviewed manifests now pin current 4.8.4. **The lockfile still needs regeneration** with `npm install` in the M4 branch before `npm ci`/CI/Docker can work.

Recommended flow: branch from accepted `main` → overlay M4 candidate → `npm install` and confirm lockfile contains `socket.io@4.8.4` and `socket.io-client@4.8.4` → `npm audit` review → open PR and use a real green Actions run for the full test/build/Docker gates → verify two-window real-time events, reconnect/resync, tenant isolation and access revocation on an isolated M4 database. Only then accept M4.

## Invariants
- Tenant derived from authenticated membership; cross-tenant reads are 404; server-side role checks.
- Secure/revocable sessions, CSRF/Origin allow-list, invitations hashed/single-use, minimum one organization owner.
- State transitions constrained in service and DB; optimistic concurrency 409; append-only incident timeline and audit trail.
- PostgreSQL durable queue (not Redis/BullMQ) with transactionally enqueued jobs, retries, lease fencing and poisoned-job isolation.
- AI is optional/advisory; human applies suggestions through the audited API. No live OpenAI verification; Gemini adapter is unimplemented and remains disabled.
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

## Handoff update (2026-10-16): Milestone 7 (implemented, NOT accepted)
Alertmanager webhook with Bearer integrations and alert-cycle dedupe. Read `docs/decisions/0018-alertmanager-ingestion.md`, `docs/integrations/alertmanager.md` and `docs/verification/milestone-7-status.md` (what ran vs what did not). Migration 0007 is new and unapplied anywhere. Only a sandbox stand-in ran the tests; real Jest/CI/Docker/browser are pending. Never run `services:reset`; never edit applied migrations; never print tokens.
