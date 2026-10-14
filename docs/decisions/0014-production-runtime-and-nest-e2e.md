# 0014 Production runtime, queue failure isolation, and Nest E2E

**Status:** Implemented in the Milestone 3 source; Windows/CI evidence must be recorded separately after these changes are run.

## Queue failure isolation

The exhausted-lease reaper claims **one** expired job per transaction with `FOR UPDATE SKIP LOCKED`. The worker keeps the reaping transition and the handler's terminal failure update in the same transaction. If that handler update throws, the transaction rolls back only that job; the worker logs it (at most once per minute per job, so a permanently failing finalizer cannot flood the log), and continues.

**Review correction (found by a failing test, not by inspection).** The first Milestone 3 version reaped only one candidate per `runOnce()` and always picked the oldest expiry. A permanently poisoned job at the head of the line was therefore retried forever and **no exhausted job behind it was ever finalized**: their analyses stayed `running` indefinitely. Claiming of runnable work was not affected, so the "does not starve healthy jobs" test passed. The worker now loops (bounded at 25 per pass), passes the ids that already failed finalization in this pass to `reapExhausted(tx, excludeIds)`, and moves on to the next exhausted job. The poisoned job stays `running` and recoverable and is retried on the next pass. Regression test: "a poisoned exhausted job at the head of the line does not block finalizing other exhausted jobs" (red before, green after).

## Real Nest end-to-end analysis test

The API now injects the OpenAI fetch transport through an internal Nest provider token. Production uses global `fetch` and the provider's hard-coded `https://api.openai.com/v1/responses` endpoint. The integration test overrides only that transport and validates the destination is the fixed production URL before redirecting the request to a local deterministic HTTP server. It boots the actual Nest module/controllers, production HTTP middleware, actual `pg` pool, database migrations and worker lifecycle; it does not substitute the HTTP handlers or the worker.

The flow registers an account, creates an incident, lets the real worker complete the automatically enqueued analysis, explicitly requests a second analysis through the HTTP API, and applies the suggested severity through the regular audited update endpoint. It checks the timeline, that no email or organization identifiers are sent to the provider, and tenant isolation through the real HTTP stack (another organization's owner gets 404 for both reading and requesting analysis, and nothing reaches the provider on their behalf).

## Production containers and CI

- `apps/api/Dockerfile` builds the shared package and API, installs only runtime dependencies in the final image tree, runs as the non-root `node` user, and includes a readiness health check.
- `apps/web/Dockerfile` builds Next.js standalone output and runs the standalone server as non-root.
- Compose's default profile still starts only PostgreSQL and Redis. The opt-in `app` profile also starts the production API and web containers with health checks and dependency ordering.
- GitHub Actions CI additionally builds and starts both containers, asserts they run as a non-root user, and runs `scripts/smoke-stack.mjs` against the running stack. The smoke script is dependency-free and exercises health, the web login page, the foreign-Origin (CSRF) rejection, registration with a hardened session cookie, incident create/list/transition (stale version is 409), the timeline, AI-disabled behavior, logout revocation by replaying the old cookie, and login. It prints container logs on failure and never deletes volumes.
- The production API sets the `__Host-` prefixed `Secure` session cookie. Browsers accept it over plain http only on localhost-class hosts (Chrome and Firefox do; Safari may not), so the container stack is for local smoke testing at `http://127.0.0.1:3000`, not a substitute for deployment behind HTTPS.
- Known inefficiency, deliberately not changed without a Docker engine to verify it: the API image keeps the production dependencies of every workspace (including Next.js) because `npm prune --omit=dev` is not workspace-scoped.

## Evidence discipline

A committed test or Dockerfile is not evidence it passed. Record real Windows or GitHub Actions command output after running these changes. Live OpenAI calls are not part of CI; the deterministic local mock is the intended integration test boundary. No overall superiority claim against the reference follows solely from this decision.


---
**Update 2026-10-14 (added; the text above is the historical record).** Milestone 3 was accepted on 2026-10-13 from maintainer-REPORTED Windows, browser and GitHub Actions evidence (see `PROJECT_MEMORY.md` section 5a). The status line above is therefore historical. Milestone 5 (ADR 0017) removed the Compose `redis` service and the unused `ioredis` dependency referenced here.
