# Incident Platform — Persistent Project Memory

**Purpose:** Durable handoff across Claude/GPT chats. The current source ZIP is the source of truth for code; actual command output is the source of truth for verification. This file is context, not proof that a feature works.

**Last updated:** 2026-10-13, after Milestone 3 was accepted from user-reported Windows, browser and GitHub Actions evidence and after an independent Milestone 4 source review. **Milestone 3 is ACCEPTED. Milestone 4 remains an unverified implementation candidate** until its lockfile, runtime, integration and two-window checks pass. The latest clean M4 source candidate is `incident-platform-milestone4-realtime-candidate.zip`; use the revised review candidate versioned with Socket.IO 4.8.4 when available.

**Update 2026-10-14 (Milestone 5 implemented, NOT accepted).** M4 was merged by the maintainer and its lockfile now contains `socket.io`/`socket.io-client` (maintainer-reported). M5 (production readiness and runtime verification) is implemented in this source and is **unaccepted**: Jest, `npm ci`, `npm audit`, ESLint, `next build`, every Docker run, CI and the manual two-window browser check were **not run** in the authoring sandbox (registry and Docker Hub blocked). See `docs/verification/milestone-5-status.md` (evidence classes, test accounting, results), `docs/decisions/0017-production-readiness-and-runtime-verification.md` and `docs/security/npm-audit-m5.md`. M5 changes: optional `REDIS_URL`; `ioredis` and the Compose Redis service removed (nothing used them); `smoke:stack` gained six WebSocket checks (run in CI, with a negative control); optional single-origin Caddy proxy topology (`docker-compose.edge.yml`, `deploy/edge/Caddyfile`); `TRUST_PROXY_HOPS` integration tests; login/register verify the session via `/api/auth/me`. Older text below is kept as history; where it says Redis is provisioned, the lockfile is not regenerated, or the smoke test has no WebSocket check, that is superseded by this paragraph.

## 1. Mission and non-negotiable quality rule

Build a genuinely better incident-operations platform than the upstream reference **`julmtoz/ai-incident-intelligence`**. Do not merely rename/reskin it or add technology for appearance. At each meaningful phase, compare actual working behavior with the reference, explain what is ahead/equivalent/behind, and support claims with tests, runtime, security, CI, and deployment evidence. Do not claim overall superiority until the meaningful gaps are closed and evidence supports it. Preserve the upstream MIT license and third-party notices, and be transparent about reused code.

## 2. Working relationship and user's preferences

- **Claude:** Lead implementation engineer. Work autonomously, make justified decisions, implement, debug and test. Do not stop after an audit or ask routine questions. Maintain persistent Claude project memory if available and keep this Markdown handoff current at each accepted milestone.
- **GPT:** Independent source/code reviewer. Identify genuine security, correctness, reliability or quality risks; don't invent work or request needless checks.
- **User:** Runs only essential Windows PowerShell commands and shares actual output. Keep commands few and precise, avoid repeated setup loops, and never request env-file contents or secrets.
- The authoring sandbox may have no npm registry or Docker Hub access (egress policy returns 403): check first, and if so say plainly which checks could not run. Do not try to route around the policy.
- Never claim unrun tests passed. Clearly distinguish actual Jest/pg/Nest/Next/PostgreSQL/Docker/CI tests from sandbox stand-ins and syntax-only checks.

## 3. Reference repository and comparison

Reference: `julmtoz/ai-incident-intelligence`.

Observed reference strengths: live Railway deployment, CI evidence, GitHub issue enrichment, a smaller surface known to run. Observed weaknesses include no authentication/tenancy and a database-write-then-Redis-enqueue dual write/startup recovery sweep; AI was mandatory and analysis wrote back to the incident. Compare source, not marketing/README alone.

Our product has implemented authentication, organizations/roles/invitations, tenant isolation, audited incident lifecycle, optimistic concurrency, PostgreSQL constraints/triggers, a durable PostgreSQL queue with leases/fencing, and the Milestone 3 Docker/CI workflows. Milestone 3 Windows tests, browser workflow and GitHub Actions green status were confirmed by the user on 2026-10-13. Overall superiority is still **not proven**: production deployment, live OpenAI calls and GitHub issue enrichment are unverified; Milestone 4 real-time delivery is still a candidate pending real verification.

## 4. Accepted Windows-verified baseline: Milestone 2.1

Baseline archive before the current Milestone 3 additions: `incident-platform-milestone2.1-windows-verified.zip`.

Windows results (2026-10-12):
- Root script tests: **15 passed**.
- Shared Jest tests: **37 passed**.
- API unit Jest tests: **120 passed**.
- Web Jest tests: **13 passed**.
- Total unit tests: **185 passed**.
- PostgreSQL integration tests: **119/119 across 9 suites passed**, with the real `pg` pool.
- TypeScript checks, ESLint, production build passed.
- Five migrations applied; migration status said none pending.
- Browser smoke: logged in at `http://127.0.0.1:3000`, created “API response time high” (SEV2 · Major, Triggered), and saw it in the incident list.
- The `ts-jest` `TS151002` warning was non-fatal in those baseline runs. Milestone 3 adds `isolatedModules: true` in API tsconfig to address it; that change has not yet been run with Jest.
- No live OpenAI request or complete real Nest-to-AI workflow had been verified in Milestone 2.1.

Two test-only corrections in the accepted baseline: (1) normalize JSON-shaped values in two web API-client test assertions because strict deep comparison under Jest's VM reported prototype differences despite identical values; (2) use valid DB job type `atomic_reaper` instead of invalid `atomic-reaper`.

## 5. Milestone 3 — accepted after Windows, browser and CI verification

**Accepted source:** commit `8e0a1d3` on `main` in `https://github.com/aayushtiwari307/incident-intelligence-platform`, based on the Windows-verified Milestone 2.1 source. It introduces no new runtime dependencies or migrations (migrations 0001–0005). Acceptance evidence is recorded in section 5a.

### What the candidate contains
1. **Queue poison-job isolation.** `JobQueue.reapExhausted(tx, excludeIds)` claims ONE expired exhausted job per transaction (`FOR UPDATE SKIP LOCKED`, ordered by oldest expiry). `JobWorker.reapExhausted()` loops (max 25 per pass): job `dead` transition and handler terminal update run in one transaction; if the handler throws, only that job rolls back, the failure is logged (redacted, at most once/minute/job), the job id is excluded for the rest of the pass, the next exhausted job is tried, then normal work is claimed.
2. **Review correction (lead engineer).** The first Milestone 3 version picked only the oldest exhausted job each pass, so a permanently poisoned job at the head of the line blocked finalization of every exhausted job behind it (their analyses stayed `running` forever). Found by writing a failing test first (red on the candidate, green after the fix). Regression test: "a poisoned exhausted job at the head of the line does not block finalizing other exhausted jobs".
3. **Nest HTTP → AI end-to-end test** `apps/api/src/http/nest-ai.int.test.ts`: real `AppModule`, controllers, `configureHttpApplication` middleware, real `pg` pool, migrations, worker lifecycle; deterministic local HTTP mock of the OpenAI Responses API injected through the `OPENAI_FETCH` DI token (the provider URL stays the fixed `https://api.openai.com/v1/responses`; the test asserts that before redirecting to loopback). Flow: register → create incident → automatic analysis → explicit second analysis → apply suggested severity via ordinary audited PATCH → timeline → 401 without session → **(added in review) tenant isolation: another org's owner gets 404 for GET and POST analysis and nothing reaches the provider.**
4. **Container smoke script** `scripts/smoke-stack.mjs` (+ `npm run smoke:stack`, 4 unit tests): dependency-free HTTP checks of a running stack — health, web `/login`, foreign-Origin rejection (403 ORIGIN_NOT_ALLOWED), registration + hardened cookie (HttpOnly, SameSite=Lax; `__Host-` ⇒ Secure, Path=/, no Domain), me, incident create/list, transition + stale version 409, timeline, AI-disabled behaviour (409 FEATURE_DISABLED), 401 without session, logout revokes the session (old cookie replayed → 401), wrong password 401 / login 200.
5. **Production containers:** `apps/api/Dockerfile`, `apps/web/Dockerfile` (Next `output: "standalone"`, `outputFileTracingRoot` = repo root), non-root `node` user, health checks. Compose default profile = PostgreSQL + Redis only; opt-in `app` profile builds/runs API + web (loopback-only ports 3000/3001, `MIGRATE_ON_START=apply`). `npm run services:app-up` / `services:app-down` (no `-v`).
6. **CI** `.github/workflows/ci.yml`: concurrency group, 30-min timeout, checks (deps, hygiene, typecheck, lint, unit, real-Postgres integration, build), then builds+starts the full Compose app stack, asserts API and web containers run as non-root (`id -u`), runs `npm run smoke:stack`, prints container logs only on failure, stops without deleting volumes. **User confirmed the GitHub Actions run for commit `8e0a1d3` was green on 2026-10-13; the run URL was not preserved in this handoff.**
7. Other: `configureHttpApplication` shared by `main.ts` and the E2E; `isolatedModules: true` in `apps/api/tsconfig.json` (ts-jest then transpiles without per-file type-check — `npm run typecheck` is the type gate; also targets the TS151002 warning, not yet confirmed gone); `@types/express` exact-pinned 5.0.6; Gemini stays disabled; no new env var can redirect the OpenAI URL; ADRs 0014 and 0015, README, DEVELOPMENT, testing conventions updated.

### Historical pre-Windows evidence for the M3 candidate (superseded by the actual results in section 5a; retained for provenance)
| Category | Result |
|---|---|
| **Real tools** | Root script tests 19/19 (15 + 4 new); repo hygiene OK on a git-initialised copy; `docker compose config` valid for default and `app` profiles (Compose v5.5.1); `@platform/shared` builds with tsc 6.0.3; strict tsc 6.0.3 type-check of all non-Nest API sources (stubs for pg/express/jest; project pins TS 5.9.3 so not the project's own check) |
| **Sandbox harness** (Jest-style suites via `node:test` + `tsx`, ~250-line wire-protocol client instead of `pg`, **real PostgreSQL 16.15**) | Calibrated on the accepted M2.1 baseline: 119/119 (matches Windows). Milestone 3 as received: 119/119. After the correction + 1 new test: **120/120** integration; API unit 120/120; shared 37/37. Web unit tests not run |
| **Sandbox stand-ins** (no Nest, no Express, no Docker, no browser) | Nest E2E scenario replayed at `ApiHandlers` level with a local mock OpenAI HTTP server: pass. `smoke-stack.mjs` against a small `node:http` front over `ApiHandlers` in production-cookie mode: 14/14 |
| **NOT run anywhere** | Jest; real `pg` pool; NestJS startup; `nest-ai.int.test.ts` itself; ESLint; web unit tests; `next build` with standalone output; any Docker image build or container start; browser smoke on the container stack; GitHub Actions; live OpenAI; TS 5.9.3 type-check |

Expected on Windows/CI when all pass: root scripts 19, shared 37, API unit 120, web 13 (**189 unit**); PostgreSQL integration **121 tests across 10 suites** (119 baseline + head-of-line test + Nest E2E).

### 5a. Milestone 3 acceptance status — ACCEPTED (as of 2026-10-13)

**User-confirmed Windows evidence for the committed M3 source (`8e0a1d3`):**
- `npm ci` completed successfully. It reported 20 moderate npm audit findings and deprecation warnings; no bulk fix was applied.
- `npm run typecheck` and `npm run lint` passed.
- `npm test`: **189 total unit/repository tests passed** (root scripts 19, shared 37, API 120, web 13).
- `npm run test:integration`: **121/121 tests passed across 10 suites**, using Jest and the actual PostgreSQL driver.
- `npm run build` passed, including the production Next.js build.
- Docker API and web images built. PostgreSQL, Redis, API and web containers became healthy. Non-root checks passed.
- `npm run migrate:status` reported five migrations applied, none pending, when the intended database URL was supplied.
- Actual container `npm run smoke:stack`: **14/14 checks passed**.
- Manual browser workflow at `http://127.0.0.1:3000`: user registered/logged in, created incident `#1 Milestone 3 Browser Verification`, refreshed the page and verified the incident persisted, opened the detail page and added a comment that appeared in the timeline.
- After commit `8e0a1d3` was pushed to `main`, the user confirmed GitHub Actions showed a green run. The exact run URL was not captured here; the reported green result is user-supplied evidence, not independently fetched by this handoff.

**Verdict:** Milestone 3 is accepted. Do not rerun the full M3 test suite without a relevant change. Preserve the accepted commit and the `incident-platform-milestone2.1-windows-verified.zip` archive as fallback.

**Remaining product limitations (not M3 blockers):** live OpenAI calls and deployment have not been verified; overall superiority over the upstream reference is not established. npm audit findings/deprecation warnings should be reviewed in a focused dependency pass; do not apply indiscriminate breaking updates.

### Known limits / risks left open
- The `__Host-` `Secure` cookie in the production-mode container works over http only on localhost-class hosts (Chrome/Firefox; Safari may not); browse the stack at `http://127.0.0.1:3000`. The CI smoke script sets cookies by hand and cannot prove browser behaviour.
- API image keeps all workspaces' production deps (incl. Next.js) because `npm prune --omit=dev` is not workspace-scoped — size only; not changed without Docker to verify.
- `check:deps` only reflects an installed tree (vacuous without `node_modules`); `check:hygiene` needs a git work tree (`git ls-files`).
- Compose interpolates `POSTGRES_PASSWORD` into `DATABASE_URL` unencoded: avoid special characters.
- Worker runs in the API process; the idle poll is 2 s; rate limiters are in-process (ADR 0010).

## 5b. Milestone 4 candidate — secure real-time incident updates (Socket.IO)

**Status:** implemented in source on top of the unaccepted M3 candidate; **not verified at runtime**. Design, threat model and rejected alternatives: `docs/decisions/0016-secure-realtime-updates.md`.

### Contents
- **Protocol** `packages/shared/src/realtime.ts`: `realtime.ready`, `incident.event` (`{eventId, incidentId, event, incident}`), `realtime.resync`; handshake refusal codes. No client-to-server messages.
- **Migration `0006_incident_events_notify.sql`**: `AFTER INSERT` trigger on `incident_events` calling `pg_notify('incident_events', {"id","o"})` (delivered only on commit, in commit order, covers every writer incl. raw-SQL member removal). Migrations 0001–0005 untouched.
- **API** `apps/api/src/realtime/`: `hub.ts` (framework-free core: handshake auth via session cookie, org-room join, per-user cap 10, sequential tenant-filtered delivery, resync on any doubt, batch access re-checks, fail-closed), `listener.ts` + `pg-listen.ts` (dedicated LISTEN connection, backoff, gap signalling, 30 s heartbeat), `socketio-gateway.ts` (thin Socket.IO adapter: websocket-only, Origin check via `allowRequest`, 1 KiB buffer, no client-event handlers, no connection-state recovery), `realtime.service.ts` (Nest lifecycle; attached from `configureHttpApplication`, so `main.ts` and E2E share one path; closes before HTTP server/pool), `notification.ts`, `origin.ts`, `types.ts`.
- **Service additions:** `AuthService.resolveSessions(ids)` (batch, same validity rules as `authenticate`); `IncidentService.loadRealtimeMessage(orgId, eventId)` (org-filtered; `events()` now shares `toEventDto`); `ApiHandlers` option `onAccessChanged` fired after logout, organization switch, invitation redemption, member removal.
- **Config:** `REALTIME_ENABLED` (default true, strict boolean), `REALTIME_REVALIDATE_SECONDS` (1–300, default 10); in `describeConfig`.
- **Web:** `lib/realtime-state.ts` (version-guarded snapshot/timeline/list reconciliation), `lib/realtime-client.ts` (connection driver; resync on every `ready`, retry rules, fatal refusals refresh the session), `lib/socket-factory.ts` (only socket.io-client user), `lib/use-realtime.ts`, `LiveStatus` indicator; incident list and detail pages update live; the edit form saves against the version it started from (a live update cannot cause a silent overwrite).
- **Dependencies (pinned exact):** `socket.io 4.8.4` (api), `socket.io-client 4.8.4` (api dev and web). Version 4.8.4 was the current published stable release for both packages on 2026-10-13 (npm package pages: https://www.npmjs.com/package/socket.io and https://www.npmjs.com/package/socket.io-client). **`package-lock.json` is still NOT regenerated in this archive** because registry access was unavailable in the authoring sandbox; run `npm install` once in the M4 working branch, confirm the lock now includes both packages, and commit it before `npm ci`, CI or Docker builds. Run `npm audit` against the regenerated lockfile and review findings before accepting the milestone.

### Evidence for M4 (exact)
| Category | Result |
|---|---|
| Run in authoring sandbox (Node 22.22, tsx + a node:test shim for Jest globals — **not Jest**; zod 3.23 stand-in; no pg, no Socket.IO, no PostgreSQL, no Nest) | New API unit tests 63 (notification 15, origin 5, hub 36, listener 7) + 7 new config tests: pass. New web unit tests 28 (state 16, client 12): pass. Existing `env.test.ts` 26 + 7 new: pass |
| Mutation checks (sandbox) | Deliberately breaking the hub (wrong broadcast room; sweep ignoring organization change; skipping the role check at handshake) made the corresponding tests fail; restored = pass |
| Type check | tsc 6.0.3 strict (project pins 5.9.3), with ambient stubs I wrote for socket.io/pg/Nest/jest globals, over the realtime core, listener, gateway, auth/incident services, handlers, env, and web state/client + their tests: 0 errors. Stubs encode my belief about those libraries' APIs, so this checks internal consistency only. Syntax-only transpile of all 48 new/changed TS/TSX files: 0 errors |
| **NOT run** | Jest; ESLint; `next build`; the real Socket.IO server/client; the SQL migration and trigger; `resolveSessions`, `loadRealtimeMessage`; the three new integration suites; Nest startup; Docker; browser; CI; the web pages/hook (React) |

Expected when everything passes (after `npm install` + lockfile): unit **287** (189 + 70 API + 28 web; shared unchanged 37), PostgreSQL integration **154 across 13 suites** (121 + 33: `realtime-data` 13, `nest-realtime` 15, `access-hook` 5).

### Unverified assumptions most likely to need a fix on first real run
- Socket.IO API details used by `socketio-gateway.ts` (`allowRequest`, `io.use` error `.data`, `disconnectSockets(true)` + `io.engine.close()` instead of `io.close()`, `socket.join` return).
- `socket.io-client` in Node honouring `extraHeaders` for `Cookie` and `Origin` on the websocket transport (used by `nest-realtime.int.test.ts`).
- Nest shutdown order (`beforeApplicationShutdown` runs before the HTTP server closes) and that `app.get(RealtimeService)` works before `listen`.
- `pg_terminate_backend` of the LISTEN session in the recovery test requires a role allowed to do so (the test admin role normally is).
- The CI `smoke:stack` does not exercise Socket.IO (no WebSocket check was added because it could not be validated here); real-container proof of M4 needs the manual two-window check in `docs/DEVELOPMENT.md`.

## 6. Architecture and product functionality

- Frontend: Next.js App Router, React, TypeScript. Pages include login, register, incidents/list/detail, and team. Use `http://127.0.0.1:3000` locally; don't substitute `localhost` because cookie/Origin behavior can differ in this setup.
- API: NestJS, TypeScript, REST. Core request/business rules are in framework-free `ApiHandlers` and thin Nest controllers.
- DB: PostgreSQL through direct `pg`, handwritten SQL, numbered migrations. No ORM.
- Jobs: durable **PostgreSQL queue**, not BullMQ. Uses transactional enqueue, `FOR UPDATE SKIP LOCKED`, leases, lease fencing, retry/backoff and idempotent analysis persistence. Redis is not the job queue (and, since M5, is no longer provisioned in Compose).
- AI: optional OpenAI Responses API via `fetch`; strict Zod output validation; only incident title, description, severity, status should be sent; output is advisory and human applies suggested severity through audited update. AI disabled by default. No live OpenAI call yet; model name `gpt-5-mini` is not verified live. Gemini adapter is not implemented and must remain disabled even if a Gemini key exists.
- Organizations/security: scrypt password hashing, opaque random session token stored as SHA-256, HttpOnly SameSite=Lax cookie, server-side logout/revocation, live role reads, roles viewer/responder/admin/owner, single-use email-bound invitation tokens, Origin allow-list checks for writes, tenancy derived from authenticated membership (never request org id), composite tenant constraints, cross-tenant IDs return not-found.
- Incidents: create/list/filter/paging/detail/edit/assign/status/comment/timeline; optimistic concurrency -> 409; timeline entries must reflect all related changes. Removing members atomically unassigns affected incidents and writes corresponding timeline events. Status state machine enforced by service and DB trigger. Owner invariant enforced under concurrency.
- Real-time (M4 candidate): Socket.IO on the API port, WebSocket only; cookie-authenticated handshake with Origin check; one room per active organization chosen by the server; pushes driven by a PostgreSQL NOTIFY trigger on `incident_events`; `realtime.resync` + REST reload for any recovery; access re-checked immediately on this instance after logout/switch/removal and every 10 s otherwise.
- RLS deliberately deferred until it can be implemented and tested against actual `pg` pool with pooled transaction context and a pool-of-one tenant-interleaving test.

## 7. Migrations, environment and safety

- Migration files `0001` through `0005` are already applied (`0006_incident_events_notify.sql` is new in the M4 candidate and not applied anywhere yet) to the user's local database on the earlier Milestone 2.1 project. Never edit applied migrations; add a new numbered migration if needed.
- On Windows project path for accepted baseline: `C:\Users\Aayush Tiwari\Downloads\incident-platform-milestone2.1\incident-platform`. The user will extract Milestone 3 separately.
- Local `.env`, `apps/api/.env`, `apps/web/.env.local` live outside source ZIP and should stay private. Never print or package their contents.
- Local ports (M5: no Redis service; optional edge proxy on `127.0.0.1:8080`): PostgreSQL `127.0.0.1:5434`, Redis `127.0.0.1:6380` (**removed in M5**), API `3001`, web `3000`.
- Do not casually run `npm run services:reset`; it deletes Compose volumes/data. Check Docker state before startup.
- Integration test env uses `TEST_DATABASE_URL` pointing to the project's Postgres admin DB (`127.0.0.1:5434/postgres`) and creates/drops random scratch DBs; validate host/port/database before running.

## 8. Next engineering steps

1. **Milestone 3 is accepted.** Keep commit `8e0a1d3` on `main` as the accepted M3 source. The latest user-reported Windows and green Actions evidence is recorded in section 5a; do not repeat its test suites without a concrete reason.
2. **Milestone 4 candidate:** create a branch from accepted `main`, overlay the complete M4 source archive, regenerate `package-lock.json` with `npm install`, verify it contains `socket.io@4.8.4` and `socket.io-client@4.8.4`, and run `npm audit`. Do not apply migration 0006 to the M3 baseline database; use an isolated M4 Compose project/database.
3. Let an actual GitHub pull-request Actions run perform the complete Jest/typecheck/lint/integration/build/Docker gates once the lockfile is valid. Fix real failures without weakening tests. Run local checks only when CI errors need diagnosis or a specific change needs targeted verification.
4. After automated gates pass, apply migration `0006_incident_events_notify.sql` only to the isolated M4 database and complete the documented two-window browser check (real-time event delivery, refresh/reconnect recovery, tenant isolation and sign-out/access revocation). The existing HTTP `smoke:stack` does not verify WebSockets.
5. Only after Milestone 4 runtime/CI acceptance: consider production deployment, GitHub issue enrichment, and live OpenAI verification (keep keys out of CI). Re-compare to `julmtoz/ai-incident-intelligence` against fresh source and runtime evidence.
6. Possible follow-ups, not yet started: push AI analysis status; (done in M5, unverified) real WebSocket steps in `smoke:stack`; handshake rate limiting; (done in M5, unverified) login/register verify the session via `/api/auth/me`.

## 9. Handoff rules

At a new chat, read this file and inspect the current source ZIP. If memory differs from source or command evidence, state the discrepancy and reconcile. At each accepted milestone, update this file and Claude's persistent project memory if available with exact features, migrations, tests and environment, warnings, gaps, reference comparison and next phase. Never claim memory persistence unless actually updated. Milestone 3 is accepted based on section 5a. Never describe Milestone 4 as verified before its real CI and two-window runtime gates in section 8 have passed. A portable summary for pasting into a new chat is in `docs/HANDOFF.md`.

## 2026-10-14 update: M5 invitation acceptance verification

- Local Docker Desktop was started. The M5 PostgreSQL host mapping in `docker-compose.yml` was changed from `127.0.0.1:5434:5432` to `127.0.0.1:5545:5432` because the older M3 PostgreSQL container already occupied host port 5434. The M5 API configuration uses port 5545.
- PostgreSQL started successfully and `Test-NetConnection 127.0.0.1 -Port 5545` returned `TcpTestSucceeded: True`.
- The API started successfully on `127.0.0.1:3001`; the Next.js web app started on `127.0.0.1:3000` after temporarily stopping `incident-platform-m3-web-1` (container not deleted).
- Invitation record inspection confirmed the invite for the test Viewer email was unexpired, unaccepted, unrevoked, and assigned the `viewer` role in the Test Owner organization.
- Viewer authentication through the API returned HTTP 200. Posting the entire registration URL as the invitation token returned HTTP 404 because the accept endpoint expects the raw token, not the URL.
- Extracting the token from the `#invite=` URL fragment and posting it to `POST /api/organization/invites/accept` returned HTTP 200. The response confirmed membership in the Test Owner organization with role `viewer`; the test account retained its owner membership in its original Viewer organization.
- Conclusion: direct API invitation acceptance is verified. Browser-based acceptance was not independently retested, so no claim is made that the browser flow itself was verified.
- The local Team page includes invitation-link/token copy controls. `relativeTime()` was updated to handle future timestamps and its test was extended.
- `.env` is ignored and not tracked. Never commit `.env`, local backup files, audit output, passwords, or invitation tokens. The one-time token used during this test was consumed and must not be reused.
