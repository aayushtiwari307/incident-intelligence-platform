# 0013 Milestone 2 reliability-review corrections

**Status: implemented in source; full tests require Windows verification.**

## Atomic exhausted-job reaping

The initial Milestone 2 worker marked exhausted jobs `dead` in one autocommit operation, then called the job handler's final-failure callback in a separate transaction. If the process crashed or the callback failed in between, a domain record (for example, an `incident_analyses` row) could remain `running` permanently: the dead job would no longer qualify for reaping.

Reaping the job and invoking its handler's final-failure transition now happen inside one `Database.tx`. If the callback fails, the transaction rolls back both the job status update and the domain update. The expired running job remains eligible for a later reaper pass. An integration regression test simulates the callback failing once and verifies rollback and successful retry.

## Unsupported provider configuration

The configuration accepted `AI_PROVIDER=gemini` and, if `GEMINI_API_KEY` was present, reported `ai.enabled = true`, even though the provider factory has no Gemini adapter and the feature was consequently unavailable in the application. The configuration now reports AI disabled with the reason `Gemini provider is not implemented`. A unit test covers the configured-key case. OpenAI remains the only implemented provider.

## Verification evidence from Milestone 2.1 Windows baseline

- Repository script tests: **15 passed**.
- Shared/API/web Jest unit tests: **185 passed**.
- PostgreSQL integration tests: **119/119 passed across 9 suites**.
- TypeScript checks, ESLint and production build: passed.
- Five migrations applied, none pending; browser smoke test created an incident visible in the real incident list.

Those are baseline results, not proof that the additional Milestone 3 source edits have passed. The new queue regression test and Nest E2E test, Docker images, and updated CI still require execution on a machine with the project dependencies and Docker. No live OpenAI API call is required or claimed.
