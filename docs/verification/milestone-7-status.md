# Milestone 7 verification status: Alert intake and deduplication

**Status correction (2026-10-17): M7 is merged to `main` in `3c6231502dd736f266f7defd7aba1f32a455869c`, the merge commit for PR #2. It was subsequently included in the combined Render deployment verified on 2026-10-24. This does not prove that a real external Alertmanager integration has been tested.** The status and verification notes below describe the pre-merge candidate review and are retained as historical evidence.

## Final verification evidence

The earlier authoring/sandbox attempts were incomplete: registry access and Docker were unavailable, and the installed Windows PostgreSQL service was not considered safe to use as a disposable test server. Those attempts did not run the project's real database integration suite. They are historical and superseded by the isolated verification below.

- **Quality checks passed on the candidate:** `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run check:deps`, `npm run check:hygiene`, and `git diff --check`.
- **PostgreSQL integration tests passed:** 16 suites, 214 tests, using the real Jest/ts-jest/`pg` stack against a newly initialized, disposable PostgreSQL 17 cluster. The cluster was bound only to `127.0.0.1`; its data directory, port, listener address, `postgres` identity, superuser/`CREATEDB` privileges and connection URI were verified before tests ran. The harness created uniquely named scratch databases, applied migrations and dropped them after use.
- Integration coverage includes resolved-before-firing followed by delayed firing, a legitimate new cycle with a different `startsAt`, concurrent duplicate deliveries, token rotation and revocation, organization isolation, transaction rollback, and webhook authentication/invalid credentials.
- **Live candidate API simulator passed:** 11 checks, including invalid-token HTTP 401 with `UNAUTHENTICATED`. It ran against the actual candidate API on loopback using a throwaway organization and integration, not the simulator's fake-server test.
- **Packaging checks passed:** the source ZIP contained the committed source snapshot and extracted successfully; `git apply --check` passed in a disposable worktree at the accepted baseline.
- The temporary PostgreSQL cluster, integration scratch databases, candidate API process and process-scoped test configuration were cleaned up or restored.
- Integration and live API checks were run before packaging; they were not repeated during packaging.

## Limitations and release state

- Rate limiting is currently in-memory and per process; it is not shared across API instances.
- A real external Alertmanager deployment was not tested; the live verification used the synthetic simulator against the candidate API.
- At the time this verification note was written, M7 was under review in PR #2 and had not been merged or deployed. The later Render deployment was verified on 2026-10-24; external Alertmanager integration remains untested.
