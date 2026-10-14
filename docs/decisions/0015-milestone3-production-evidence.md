# 0015 Milestone 3: production evidence and full-stack validation

**Status: source implemented; runtime acceptance pending.**

## Queue finalization isolation

The worker's exhausted-lease cleanup handles one candidate per transaction, in a bounded loop. The job `dead` transition and the handler's final-failure update are atomic. If the callback throws, that transaction rolls back, a redacted (and rate-limited) log entry is written, the job id is excluded for the rest of the pass, and the next exhausted job is tried; then ordinary work is claimed. This was corrected during review: the first version could be blocked by a poisoned job at the head of the line (see 0014).

## Real Nest end-to-end analysis flow

A `configureHttpApplication` helper is shared by production bootstrap and the Nest E2E test so body parsing limits, trust-proxy configuration, exception filtering, request-id middleware, Helmet and CORS are the same. `ApiModule` exposes an internal `OPENAI_FETCH` DI seam. Production defaults to global `fetch`; `OpenAiAnalysisProvider` still uses its fixed `https://api.openai.com/v1` base URL. The test overrides only the fetch transport, asserts the URL remains fixed, and sends the request to a local deterministic mock server. It does not call the live OpenAI API and does not replace the actual Nest controllers, worker, database pool or SQL.

The test exercises registration/session cookie, incident creation, job worker analysis completion, a second HTTP-requested analysis, applying the suggested severity through the normal incident update endpoint, and checking the stored timeline. It also verifies the request payload doesn't include the account email.

## Docker and CI

- `apps/api/Dockerfile` builds from the workspace root, compiles shared/API, prunes development dependencies from its final dependency tree, runs as `node`, and includes a readiness health check.
- `apps/web/Dockerfile` uses Next standalone output, runs the standalone server as `node`, and has a health check.
- Compose's default profile retains the local-development services (PostgreSQL/Redis) and ports. The optional `app` profile builds/runs API and web containers with health checks, startup dependency ordering, loopback-only host ports and no volume deletion on ordinary shutdown.
- GitHub Actions CI builds both production images after unit, real-PostgreSQL integration, lint, typecheck and build checks.

## Evidence

See `docs/decisions/0008-testing-conventions.md` ("Milestone 3 review") for the exact checks, and the verification report delivered with the ZIP. In short: the queue, handler, service and HTTP-handler code ran against a real PostgreSQL 16 server through a sandbox harness (not Jest, not the real `pg` driver); the Nest wiring, Jest, ESLint, the project's own TypeScript 5.9.3 type-check, the Next.js build, Docker image builds, a browser run and a GitHub Actions run have **not** been executed for this source.

Acceptance still requires, on Windows and CI: the added PostgreSQL tests and the Nest E2E under actual Jest with the real `pg` pool, `npm run typecheck`, `npm run lint`, `npm run build` (Next standalone output), `docker compose --profile app up -d --build --wait` followed by `npm run smoke:stack`, and one green GitHub Actions run. A successful local mock E2E does not mean a live OpenAI account/model has been verified, and a successful Docker build does not mean a production deployment exists.


---
**Update 2026-10-14 (added; the text above is the historical record).** Milestone 3 was accepted on 2026-10-13 from maintainer-REPORTED Windows, browser and GitHub Actions evidence (see `PROJECT_MEMORY.md` section 5a). The status line above is therefore historical. Milestone 5 (ADR 0017) removed the Compose `redis` service and the unused `ioredis` dependency referenced here.
