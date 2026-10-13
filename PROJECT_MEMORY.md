# Incident Platform — Persistent Project Memory

**Purpose:** Durable handoff across Claude/GPT chats. The current source ZIP is the source of truth for code; actual command output is the source of truth for verification. This file is context, not proof that a feature works.

**Last updated:** 2026-10-12, after the Milestone 3 lead-engineer review (candidate corrected; still NOT accepted).

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

Our product is ahead in implemented authentication, organizations/roles/invitations, tenant isolation, audited incident lifecycle, optimistic concurrency, PostgreSQL constraints/triggers, and the durable PostgreSQL queue with leases/fencing. However, overall superiority is **not yet proven** because Milestone 3 runtime/Docker/CI are unverified, live deployment hasn't been done, live OpenAI calls are not verified, and GitHub issue enrichment and push-based real-time updates are not implemented.

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

## 5. Milestone 3 — corrected candidate, runtime acceptance pending

**Deliverable:** `incident-platform-milestone3.zip` (based on the Windows-verified Milestone 2.1 source; no new runtime dependencies; no new migrations — migrations 0001–0005 only). The baseline is accepted; this candidate is **not** accepted until the Windows/CI checks in section 8 pass.

### What the candidate contains
1. **Queue poison-job isolation.** `JobQueue.reapExhausted(tx, excludeIds)` claims ONE expired exhausted job per transaction (`FOR UPDATE SKIP LOCKED`, ordered by oldest expiry). `JobWorker.reapExhausted()` loops (max 25 per pass): job `dead` transition and handler terminal update run in one transaction; if the handler throws, only that job rolls back, the failure is logged (redacted, at most once/minute/job), the job id is excluded for the rest of the pass, the next exhausted job is tried, then normal work is claimed.
2. **Review correction (lead engineer).** The first Milestone 3 version picked only the oldest exhausted job each pass, so a permanently poisoned job at the head of the line blocked finalization of every exhausted job behind it (their analyses stayed `running` forever). Found by writing a failing test first (red on the candidate, green after the fix). Regression test: "a poisoned exhausted job at the head of the line does not block finalizing other exhausted jobs".
3. **Nest HTTP → AI end-to-end test** `apps/api/src/http/nest-ai.int.test.ts`: real `AppModule`, controllers, `configureHttpApplication` middleware, real `pg` pool, migrations, worker lifecycle; deterministic local HTTP mock of the OpenAI Responses API injected through the `OPENAI_FETCH` DI token (the provider URL stays the fixed `https://api.openai.com/v1/responses`; the test asserts that before redirecting to loopback). Flow: register → create incident → automatic analysis → explicit second analysis → apply suggested severity via ordinary audited PATCH → timeline → 401 without session → **(added in review) tenant isolation: another org's owner gets 404 for GET and POST analysis and nothing reaches the provider.**
4. **Container smoke script** `scripts/smoke-stack.mjs` (+ `npm run smoke:stack`, 4 unit tests): dependency-free HTTP checks of a running stack — health, web `/login`, foreign-Origin rejection (403 ORIGIN_NOT_ALLOWED), registration + hardened cookie (HttpOnly, SameSite=Lax; `__Host-` ⇒ Secure, Path=/, no Domain), me, incident create/list, transition + stale version 409, timeline, AI-disabled behaviour (409 FEATURE_DISABLED), 401 without session, logout revokes the session (old cookie replayed → 401), wrong password 401 / login 200.
5. **Production containers:** `apps/api/Dockerfile`, `apps/web/Dockerfile` (Next `output: "standalone"`, `outputFileTracingRoot` = repo root), non-root `node` user, health checks. Compose default profile = PostgreSQL + Redis only; opt-in `app` profile builds/runs API + web (loopback-only ports 3000/3001, `MIGRATE_ON_START=apply`). `npm run services:app-up` / `services:app-down` (no `-v`).
6. **CI** `.github/workflows/ci.yml`: concurrency group, 30-min timeout, checks (deps, hygiene, typecheck, lint, unit, real-Postgres integration, build), then builds+starts the full Compose app stack, asserts API and web containers run as non-root (`id -u`), runs `npm run smoke:stack`, prints container logs only on failure, stops without deleting volumes. **Never run on GitHub yet.**
7. Other: `configureHttpApplication` shared by `main.ts` and the E2E; `isolatedModules: true` in `apps/api/tsconfig.json` (ts-jest then transpiles without per-file type-check — `npm run typecheck` is the type gate; also targets the TS151002 warning, not yet confirmed gone); `@types/express` exact-pinned 5.0.6; Gemini stays disabled; no new env var can redirect the OpenAI URL; ADRs 0014 and 0015, README, DEVELOPMENT, testing conventions updated.

### Evidence status for this exact source (do not conflate with Windows M2.1 results)
| Category | Result |
|---|---|
| **Real tools** | Root script tests 19/19 (15 + 4 new); repo hygiene OK on a git-initialised copy; `docker compose config` valid for default and `app` profiles (Compose v5.5.1); `@platform/shared` builds with tsc 6.0.3; strict tsc 6.0.3 type-check of all non-Nest API sources (stubs for pg/express/jest; project pins TS 5.9.3 so not the project's own check) |
| **Sandbox harness** (Jest-style suites via `node:test` + `tsx`, ~250-line wire-protocol client instead of `pg`, **real PostgreSQL 16.15**) | Calibrated on the accepted M2.1 baseline: 119/119 (matches Windows). Milestone 3 as received: 119/119. After the correction + 1 new test: **120/120** integration; API unit 120/120; shared 37/37. Web unit tests not run |
| **Sandbox stand-ins** (no Nest, no Express, no Docker, no browser) | Nest E2E scenario replayed at `ApiHandlers` level with a local mock OpenAI HTTP server: pass. `smoke-stack.mjs` against a small `node:http` front over `ApiHandlers` in production-cookie mode: 14/14 |
| **NOT run anywhere** | Jest; real `pg` pool; NestJS startup; `nest-ai.int.test.ts` itself; ESLint; web unit tests; `next build` with standalone output; any Docker image build or container start; browser smoke on the container stack; GitHub Actions; live OpenAI; TS 5.9.3 type-check |

Expected on Windows/CI when all pass: root scripts 19, shared 37, API unit 120, web 13 (**189 unit**); PostgreSQL integration **121 tests across 10 suites** (119 baseline + head-of-line test + Nest E2E).

### Known limits / risks left open
- The `__Host-` `Secure` cookie in the production-mode container works over http only on localhost-class hosts (Chrome/Firefox; Safari may not); browse the stack at `http://127.0.0.1:3000`. The CI smoke script sets cookies by hand and cannot prove browser behaviour.
- API image keeps all workspaces' production deps (incl. Next.js) because `npm prune --omit=dev` is not workspace-scoped — size only; not changed without Docker to verify.
- `check:deps` only reflects an installed tree (vacuous without `node_modules`); `check:hygiene` needs a git work tree (`git ls-files`).
- Compose interpolates `POSTGRES_PASSWORD` into `DATABASE_URL` unencoded: avoid special characters.
- Worker runs in the API process; the idle poll is 2 s; rate limiters are in-process (ADR 0010).

## 6. Architecture and product functionality

- Frontend: Next.js App Router, React, TypeScript. Pages include login, register, incidents/list/detail, and team. Use `http://127.0.0.1:3000` locally; don't substitute `localhost` because cookie/Origin behavior can differ in this setup.
- API: NestJS, TypeScript, REST. Core request/business rules are in framework-free `ApiHandlers` and thin Nest controllers.
- DB: PostgreSQL through direct `pg`, handwritten SQL, numbered migrations. No ORM.
- Jobs: durable **PostgreSQL queue**, not BullMQ. Uses transactional enqueue, `FOR UPDATE SKIP LOCKED`, leases, lease fencing, retry/backoff and idempotent analysis persistence. Redis is provisioned in local Compose but is not the job queue.
- AI: optional OpenAI Responses API via `fetch`; strict Zod output validation; only incident title, description, severity, status should be sent; output is advisory and human applies suggested severity through audited update. AI disabled by default. No live OpenAI call yet; model name `gpt-5-mini` is not verified live. Gemini adapter is not implemented and must remain disabled even if a Gemini key exists.
- Organizations/security: scrypt password hashing, opaque random session token stored as SHA-256, HttpOnly SameSite=Lax cookie, server-side logout/revocation, live role reads, roles viewer/responder/admin/owner, single-use email-bound invitation tokens, Origin allow-list checks for writes, tenancy derived from authenticated membership (never request org id), composite tenant constraints, cross-tenant IDs return not-found.
- Incidents: create/list/filter/paging/detail/edit/assign/status/comment/timeline; optimistic concurrency -> 409; timeline entries must reflect all related changes. Removing members atomically unassigns affected incidents and writes corresponding timeline events. Status state machine enforced by service and DB trigger. Owner invariant enforced under concurrency.
- RLS deliberately deferred until it can be implemented and tested against actual `pg` pool with pooled transaction context and a pool-of-one tenant-interleaving test.

## 7. Migrations, environment and safety

- Migration files `0001` through `0005` are already applied to the user's local database on the earlier Milestone 2.1 project. Never edit applied migrations; add a new numbered migration if needed.
- On Windows project path for accepted baseline: `C:\Users\Aayush Tiwari\Downloads\incident-platform-milestone2.1\incident-platform`. The user will extract Milestone 3 separately.
- Local `.env`, `apps/api/.env`, `apps/web/.env.local` live outside source ZIP and should stay private. Never print or package their contents.
- Local ports: PostgreSQL `127.0.0.1:5434`, Redis `127.0.0.1:6380`, API `3001`, web `3000`.
- Do not casually run `npm run services:reset`; it deletes Compose volumes/data. Check Docker state before startup.
- Integration test env uses `TEST_DATABASE_URL` pointing to the project's Postgres admin DB (`127.0.0.1:5434/postgres`) and creates/drops random scratch DBs; validate host/port/database before running.

## 8. Next engineering steps

1. **Windows verification batch** (one run; stop native `dev:api`/`dev:web` first because the app profile publishes 3000/3001). From the extracted Milestone 3 folder, in cmd.exe or PowerShell: `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, set `TEST_DATABASE_URL` (admin DB on 127.0.0.1:5434, same as before) and `npm run test:integration`, `npm run build`, `npm run migrate:status`, then `npm run services:app-up`, `npm run smoke:stack`, a browser login + incident creation at `http://127.0.0.1:3000`, `npm run services:app-down`. Report exact numbers and any failure text. (`npm run check:hygiene` only works inside a git work tree.) Never use `npm run services:reset`.
2. Push to GitHub and observe a green Actions run; record it.
3. If the Nest E2E or any new test fails under real Jest/`pg`, fix the cause (do not weaken the test); if ts-jest still prints TS151002, record it.
4. **Only after the Milestone 3 reliability and runtime gates pass:** Socket.IO real-time updates (do not start before), then deployment, then reconsider GitHub issue enrichment and live OpenAI verification (needs a key; keep out of CI). Compare against `julmtoz/ai-incident-intelligence` each phase with evidence; re-check the reference source (not re-fetched in this review).

## 9. Handoff rules

At a new chat, read this file and inspect the current source ZIP. If memory differs from source or command evidence, state the discrepancy and reconcile. At each accepted milestone, update this file and Claude's persistent project memory if available with exact features, migrations, tests and environment, warnings, gaps, reference comparison and next phase. Never claim memory persistence unless actually updated. Never describe Milestone 3 as accepted before the section 8 results exist.
