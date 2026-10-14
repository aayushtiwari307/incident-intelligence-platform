# Milestone 5 status and evidence ledger (2026-10-14)

**Milestone 5 is IMPLEMENTED IN SOURCE and is NOT ACCEPTED.** Acceptance needs the checks in section 4 to pass on Windows and in GitHub Actions, and the manual two-browser check in section 5 to be performed by a person.

Scope (approved): production-readiness and runtime verification of the Milestone 4 stack. See ADR 0017. Out of scope: public hosting, live OpenAI, GitHub enrichment, handshake rate limiting, AI-status push.

## 1. Evidence classes used in this repository

| Class | Meaning |
|---|---|
| **REPORTED** | Maintainer-reported results (Windows, GitHub). Not reproduced by whoever wrote this file. |
| **REPRODUCED** | Actually executed by the M5 author in the sandbox, with the exact command named. |
| **STAND-IN** | Executed, but not with the project's real runner (e.g. `node:test` instead of Jest). Useful, not acceptance evidence. |
| **BLOCKED** | Could not run in the authoring sandbox; reason stated. |
| **UNVERIFIED** | Nobody has run it. |

Older documents are historical records and are kept as written. Where they say "unverified candidate" or "lockfile not regenerated", read this file: the lockfile **does** contain `socket.io@4.8.4` and `socket.io-client@4.8.4` (checked in the M4 snapshot, in both the `apps/api` and `apps/web` entries).

## 2. Milestone 4 status (merged `main`, commit `2e47fce`; feature commit `52f5ddf`)

| Statement | Class | Source |
|---|---|---|
| PR #1 merged; GitHub PR CI 1/1 passed; local `main` equals `origin/main`, clean tree | REPORTED | maintainer, M5 kickoff 2026-10-13 |
| API integration 154 passed / 13 suites | REPORTED | `npm run test:integration` |
| API unit 190 passed / 17 suites | REPORTED | `npm run test -w @platform/api` (Jest) |
| Web 41 passed / 4 suites | REPORTED | `npm run test -w @platform/web` (Jest) |
| Shared 37 passed | REPORTED | `npm run test -w @platform/shared` (Jest). The kickoff called this "additional root/shared"; it is the shared package only (37 matches exactly) |
| Typecheck, lint, API build, Next build passed | REPORTED | maintainer |
| Static count of test declarations in the M4 snapshot: integration 154 in 13 files; shared 37; web 39 + parameterized rows; API unit 176 + parameterized rows; root scripts 19 | REPRODUCED (static count, **not** a test run) | `grep` over the snapshot |
| Root script tests on the M4 snapshot: 19 passed | REPRODUCED | `node --test "scripts/*.test.mjs"` in the M5 sandbox, before any M5 change |
| Manual two-browser real-time verification | **UNVERIFIED** | never reported; see section 5 |
| `npm audit` on the M4 lockfile | **UNVERIFIED** (see `docs/security/npm-audit-m5.md`) | required by the M4 handoff, never reported |
| Real-time inside containers / behind a proxy | **UNVERIFIED** until M5's CI step passes | |

### Test accounting: which command produced which number

`npm test` runs four segments in order; the totals are never summed by any tool:

| Segment | Command | M3 accepted (REPORTED, commit `8e0a1d3`) | M4 REPORTED | M5 expected (not yet observed under the real runner) |
|---|---|---|---|---|
| Root scripts | `node --test "scripts/*.test.mjs"` | 19 | not itemized in the M4 report (19 REPRODUCED here) | 29 (+10: WebSocket smoke logic and probe; setup-env tests rewritten, same count 4) |
| Shared | `npm run test -w @platform/shared` | 37 | 37 | 37 |
| API unit | `npm run test -w @platform/api` | 120 | 190 | 195 (+5 `env.test.ts`) |
| Web | `npm run test -w @platform/web` | 13 | 41 | 46 (+5 `auth-flow.test.ts`) |
| **`npm test` total** | | 189 | 268 itemized; 287 only if the 19 root tests are added | 307 |
| Integration | `npm run test:integration` | 121 / 10 suites | 154 / 13 suites | 159 / 14 suites (+5 `trust-proxy.int.test.ts`) |

The 19 root-script tests are therefore **not** claimed as passed by the M4 report; they are claimed by the M3 acceptance evidence and were re-executed (19/19) in the M5 sandbox on the M4 snapshot.

## 3. Milestone 5 implementation (what changed)

See `docs/decisions/0017-production-readiness-and-runtime-verification.md`. Summary: REDIS_URL optional and the unused `ioredis` dependency plus the Redis Compose service removed; WebSocket checks added to `smoke:stack` with a negative control; single-origin Caddy topology (`docker-compose.edge.yml`) verified by CI through the proxy; proxy-trust integration test; sign-in verifies the session through `/api/auth/me` before showing signed-in UI; audit record; documentation reconciled.

## 4. Milestone 5 validation results (authoring sandbox, 2026-10-14)

The sandbox had no npm registry access and no Docker daemon or Docker Hub access (egress proxy answered HTTP 403 for `registry.npmjs.org` and `registry-1.docker.io`). `node_modules` could not be installed.

| Check | Command | Result | Class |
|---|---|---|---|
| Root script tests | `node --test "scripts/*.test.mjs"` | **29 / 29 passed** (suites 9) | REPRODUCED |
| Repository hygiene | `node scripts/check-repo-hygiene.mjs` (git work tree) | passed, 200 tracked files | REPRODUCED |
| Dependency duplicates | `node scripts/check-dependency-duplicates.mjs` | **vacuous**: no `node_modules`, so it checks nothing | BLOCKED |
| Compose validation | `docker compose config --quiet` for default, `--profile app`, and `-f docker-compose.yml -f docker-compose.edge.yml --profile app` (Compose v5.5.1, no daemon needed) | all exit 0; edge config shows only the proxy publishing a port, `CORS_ORIGINS=http://127.0.0.1:8080`, `TRUST_PROXY_HOPS=1` | REPRODUCED |
| CI workflow syntax | YAML parse | valid | REPRODUCED |
| Smoke WebSocket logic incl. negative controls | `node --test scripts/smoke-stack.test.mjs` against a fake Socket.IO server | 14 / 14 (6 checks pass on a correct server; each of 7 server faults fails the intended check, including real-time disabled) | REPRODUCED (logic only; not a real Socket.IO server) |
| Shared tests | node:test + tsx shim | 37 / 37 | STAND-IN (not Jest) |
| Web tests | node:test + tsx shim | 46 / 46 (8+5+5+12+16 across 5 files) | STAND-IN |
| API unit tests | node:test + tsx shim, 17 files | 192 / 192 | STAND-IN |
| Mutation checks | revert `.optional()` on `REDIS_URL`; remove the user-id comparison in `verifySession` | the new tests fail (4 and 1 failures); restored: pass | STAND-IN |
| Type check of changed TS | `tsc` 6.0.3 strict over `env.ts`, `env.test.ts`, `auth-flow*.ts`, `api-client.ts` | 0 errors (project pins 5.9.3) | STAND-IN |
| Migrations apply | `psql -1 -f` of 0001…0006 on PostgreSQL 16.15 (migration files byte-identical to the M4 snapshot) | all six applied | STAND-IN (not the project's runner) |
| `npm ci`, `typecheck`, `lint`, `build`, Jest unit, **Jest integration (incl. `trust-proxy.int.test.ts`)** | project scripts | **BLOCKED** (no registry / `pg` / Nest / Jest) | BLOCKED |
| `npm run migrate:status` | | **BLOCKED** (needs compiled API + `pg`) | BLOCKED |
| Docker build, real stack, `smoke:stack` (direct, through proxy, negative control, Redis present/absent) | see CI + the PowerShell block in the handoff | **BLOCKED / NOT RUN** | BLOCKED |
| `npm audit` | `npm audit` | **BLOCKED** (registry advisory endpoint unreachable) | BLOCKED |
| ESLint | `npm run lint` | **BLOCKED** (plugins not installable) | BLOCKED |

New code that has therefore **never run under its real runner**: `apps/api/src/http/trust-proxy.int.test.ts`, the `socket.io-client` loading path in `scripts/smoke-stack.mjs`, the Caddy configuration, and the CI steps. Expect the first real run to surface small defects; fix them without weakening the checks.

## 5. Manual two-browser real-time check: UNVERIFIED

Nobody has performed it. It stays UNVERIFIED until a person does and records the date and result here. Procedure (`docs/DEVELOPMENT.md`, "Live updates"): two windows at the same address, signed in to the same organization (invite a second user), incident list open in both, create/comment in one and watch the other update with "Live"; then sign out in one window and confirm the other stays live for the remaining user while the signed-out window stops; then check from a second organization that nothing appears.

Result: *(not yet performed)*

## Invitation acceptance troubleshooting follow-up (2026-10-14)

### Verified evidence

| Check | Result |
| --- | --- |
| M5 PostgreSQL reachable on host port 5545 | PASS |
| API startup on port 3001, including migrations | PASS |
| Web development server startup on port 3000 | PASS after resolving the existing M3 port conflict |
| Invitation row is pending, unexpired, and not revoked | PASS |
| Test Viewer API login | HTTP 200 |
| Accept invitation using the raw token | HTTP 200 |
| Membership created in Test Owner organization with role `viewer` | PASS |

### Root cause of the observed 404

The first direct API acceptance attempt supplied the entire registration URL (`/register#invite=...`) as the `token` value. The endpoint expects only the raw token contained after `#invite=`. Supplying the extracted raw token then succeeded with HTTP 200. This test did not independently verify the browser-based acceptance flow; it establishes that the API accepts the valid token when supplied in the expected format.

### Local runtime note

The M5 Compose PostgreSQL host mapping is `127.0.0.1:5545:5432` to avoid colliding with the existing M3 PostgreSQL mapping on port 5434. The M3 web container `incident-platform-m3-web-1` was stopped temporarily to free port 3000; it was not deleted.

### Security and scope

The real `.env` file is ignored and not tracked. The commit must exclude `.env`, temporary `*.bak` files, `npm-audit-report.json`, passwords, and invitation tokens. The invitation token used for this test has been consumed. This result verifies the API acceptance path; it does not claim that browser-side acceptance was independently retested.
