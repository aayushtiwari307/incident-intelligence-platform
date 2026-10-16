# Milestone 7 status: Alert intake and deduplication

**Status: implemented in source, NOT accepted.** Date: 2026-10-16.

## Evidence classes
- **Stand-in (sandbox):** the npm registry was blocked (403), so `npm ci` never ran. Tests were run with a local stand-in: a PostgreSQL wire-protocol shim replacing the `pg` package and a Jest-like runner, against a real PostgreSQL 16 server (isolated, throw-away databases). These results are real executions of the project's test code and SQL, but **not** the real Jest/ts-jest/`pg` stack. CI is the authoritative run.
- **Not run in the sandbox:** real Jest and ts-jest; the real `pg` driver; the NestJS controller and module wiring and the Nest e2e suites (`nest-ai`, `nest-realtime`, trust-proxy); web Jest, `next build` and web typecheck; ESLint with typescript-eslint; `npm run build`; Docker Compose validation and the stack smoke test; GitHub Actions; the browser check of the Team page. `check:deps` was inconclusive (`npm ls` could not verify the TypeScript pin).
- **Original author evidence:** `node --test scripts/*.test.mjs` (36/36, including simulator tests) and `check:hygiene` (OK), as reported before this follow-up fix.
- **Follow-up candidate run in the editing container:** `node --test scripts/*.test.mjs` (36/36; includes the new invalid-bearer simulator probe) and `git diff --check` passed. The container had no `node_modules`, so the API TypeScript/Jest suites, web checks, lint and production build were not rerun here.

## What to run to accept (Windows)
```
npm ci
npm run typecheck
npm run lint
npm test
set TEST_DATABASE_URL=postgres://platform:YOUR_PASSWORD@127.0.0.1:5545/postgres
npm run test:integration
npm run build
```
Then, with the local stack up: create an integration on the Team page (token appears once; rotate and revoke), `set ALERTMANAGER_SIM_TOKEN=...`, `npm run simulate:alertmanager -- --base-url http://127.0.0.1:8080`. Apply migration 0007 only via the normal migrate path; never run `services:reset`.

## Not guaranteed by tests
Cross-instance rate limiting (per process by design) and behaviour of a real Alertmanager against this endpoint (only a synthetic simulator was used). This follow-up candidate adds regression and concurrent-delivery integration tests for resolved-before-firing tombstones; those tests require `TEST_DATABASE_URL` pointing to an isolated disposable PostgreSQL server and have not been run in this authoring environment.
