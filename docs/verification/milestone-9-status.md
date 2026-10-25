# Current-snapshot re-review (2026-10-24)

Important evidence boundary: this file retains historical M9 verification records. In the current coding session, M9 Jest suites, typecheck, lint, API/web builds and PostgreSQL integrations were **not rerun**; no live AI provider was called. Only `node --test scripts/*.test.mjs` ran in the current tree (62 passed, 0 failed). AI remains disabled by default. See `coding-stage-5-report.md` and the root completion report.

---

# Milestone 9 status: Grounded AI and Safety

**Status: M9 VERIFIED (local verification, 2026-10-18).** The reviewed implementation and its independent-review corrections passed the native checks below. This is not deployment, production, or live-provider evidence. No commit, PR, merge, or deployment was performed.

Design: [ADR 0019](../decisions/0019-grounded-ai-suggestions.md). Migration: `apps/api/migrations/0012_grounded_ai_suggestions.sql`. Migrations 0001–0011 were not modified.

## Native verification

All commands ran from the existing `milestone-8-similar-incidents` worktree with the installed project dependencies:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed: shared build, API typecheck, and web typecheck. |
| `npm test` | Passed: 445 tests total — repository scripts 55 (12 suites), shared 43 (5 suites), API 272 (26 suites), web 75 (7 suites). |
| `npm run test:integration` | Passed: 257 tests in 20 API integration suites against a fresh PostgreSQL 16 container bound to `127.0.0.1` only. This includes the 20 grounded-suggestion integration cases and existing M7/M8 regression suites. |
| Focused web suite: `apps/web/src/components/ai-suggestions.test.ts` | Passed: 12 tests, including older pending suggestion history, draft-only behavior, and both apply targets. |
| `npm run lint` | Passed: repository ESLint. |
| `npm run build` | Passed: shared package, API, and Next.js production builds. |
| Migration CLI `migrate` and `migrate:status` | Passed on a separate database in the disposable server: 12 migrations applied (0001–0012), zero pending. The migration ledger contains all 12 expected entries. |

The integration harness created and removed its own uniquely named databases. A post-run check found zero leftover `it_*` databases. The verification server and its migration database were isolated from all existing project containers and databases.

## M9 behavior covered

The real-PostgreSQL suite exercises disabled-server and organization-opt-in gates, queued worker processing, role checks, atomic quota under 20 concurrent requests, retries and refunds, redaction, alias-only context, citation and verbatim-quote validation, cross-tenant isolation, apply/dismiss auditing, append-only audit enforcement, and database consistency constraints. Apply only returns a draft; it does not mutate the incident. Applying a different target persists the new `applied_target` and records a second audit event; repeating the same target remains idempotent.

The web test verifies recent suggestion history keeps an older pending suggestion accessible when a newer item exists. The output schema rejects model-authored related-incident explanations; the server generates the fixed retrieval label from the trusted M8 search result.

## Integration corrections made

- Renamed the M9 job-handler factory in the existing test harness to avoid colliding with the M8 `ApiHandlers` instance.
- Added the required M9 suggestions configuration to the existing analysis-provider test fixture.
- Updated the M8 migration integration test's expected applied list to include migration 0012.
- Corrected the strict-schema test to expect Zod's unknown-key issue at the containing related-incident object.
- Kept the public deployment AI-disabled and set the daily request limit in `render.yaml`.

The initial typecheck/unit run exposed these integration issues; all affected checks passed on rerun.

## Safety and remaining limits

- No real provider request was made. AI behavior was tested with the fake provider, and the OpenAI adapter unit tests use a local mock HTTP server only.
- `AI_ENABLED` remains false by default and on the public deployment configuration; `AI_PROVIDER=fake` remains non-production only.
- No production deployment, external provider provisioning, browser smoke, CI run, or live-provider behavior is claimed.
- Redaction is best-effort; citation validation establishes provenance, not truth; and the per-user rate limiter is per process. See ADR 0019 for the design boundaries.
