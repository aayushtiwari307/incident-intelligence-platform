# Architecture decision records

Each record states the decision, why, what was rejected, and what is **not yet verified**.

| # | Decision | Status |
|---|----------|--------|
| [0001](0001-persistence.md) | PostgreSQL via `pg`, handwritten SQL migrations, thin repositories | accepted |
| [0002](0002-workspace-and-versions.md) | npm workspaces, pinned versions, no duplicate React/TypeScript | accepted; lockfile present, verify after dependency changes |
| [0003](0003-product-name.md) | Product name | **needs owner decision** |
| [0004](0004-tenancy-and-rls.md) | App-level authorization now, RLS deferred | accepted |
| [0005](0005-environment-and-secrets.md) | Env validation, proxy trust, loopback ports, optional AI | accepted |
| [0006](0006-outbox-and-queues.md) | Transactional outbox and idempotent queue processing | PostgreSQL queue implemented in ADR 0012; Redis/BullMQ relay remains deferred |
| [0007](0007-vite-issue-and-frontend-validation.md) | Vite 500 not reproduced; how the new frontend is validated | accepted |
| [0008](0008-testing-conventions.md) | Testing conventions | accepted |
| [0009](0009-owner-invariant-concurrency.md) | Owner invariant under concurrent transactions (migration 0003) | accepted |
| [0010](0010-auth-sessions-and-incident-workflow.md) | Sessions, roles, invitations, incident workflow, HTTP layer | accepted; Milestone 2.1 native Windows wiring verified |
| [0011](0011-milestone1-correctness-corrections.md) | Member-removal audit integrity and direct invitation registration | implemented; reviewed and tested in Milestone 1.2 (sandbox harness) |
| [0012](0012-durable-jobs-and-ai-analysis.md) | PostgreSQL job queue (outbox, leases, fencing) and optional AI analysis; comparison with the reference | accepted; live OpenAI unverified (Nest wiring and Jest: see the 2026-10-14 update in 0014/0015) |
| [0013](0013-milestone2-review-corrections.md) | Atomic exhausted-job reaping and unsupported-provider config truthfulness | implemented and verified in the Milestone 2.1 Windows baseline |
| [0014](0014-production-runtime-and-nest-e2e.md) | Queue poison-job isolation, true Nest E2E, production runtime and CI | Milestone 3 ACCEPTED (2026-10-13, REPORTED); see update at the end of the record |
| [0015](0015-milestone3-production-evidence.md) | Milestone 3 production evidence and acceptance gate | Milestone 3 ACCEPTED (2026-10-13, REPORTED); see update at the end of the record |
| [0016](0016-secure-realtime-updates.md) | Secure real-time incident updates: Socket.IO, session-cookie auth, org rooms, LISTEN/NOTIFY, resync recovery | merged to `main` (Milestone 4); unit/integration/CI results REPORTED by the maintainer; container, proxy and browser behaviour UNVERIFIED (see 0017, `docs/verification/milestone-5-status.md`) |
| [0017](0017-production-readiness-and-runtime-verification.md) | Milestone 5: single-origin proxy topology, optional/removed Redis, proxy-trust tests, WebSocket smoke, session verification after sign-in | implemented in source 2026-10-14; **not accepted** |
| [0018](0018-alertmanager-ingestion.md) | Milestone 7: Alertmanager webhook, bearer integrations, alert-cycle deduplication, retry-compatible status codes | implemented in source 2026-10-16; **not accepted** |
| [0019](0019-grounded-ai-suggestions.md) | Milestone 9: grounded AI suggestions: alias citations with verbatim quotes, redaction, org opt-in, atomic daily quota, draft-only apply, audit | implemented in source 2026-10-18; **not accepted**; testing deferred |
