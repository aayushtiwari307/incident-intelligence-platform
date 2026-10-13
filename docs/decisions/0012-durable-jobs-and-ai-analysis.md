# 0012 Milestone 2: durable PostgreSQL jobs and optional AI incident analysis

## Why this increment (comparison with the reference, `julmtoz/ai-incident-intelligence`)

Compared from the source of the reference as supplied (`backend/`, `frontend/`, `prisma/`, README, CI), not from its README claims alone.

| Area | Reference (observed in the code) | This project after Milestone 2 | Evidence here |
|------|----------------------------------|-------------------------------|---------------|
| Users / tenancy | None: no login, one shared incident list. | Accounts, organizations, four roles, invitations, tenant isolation. | 118 real-PostgreSQL integration tests in total (ADRs 0008, 0010) |
| Incident lifecycle | Create and view; AI fills severity/category once. | Status state machine (service + DB trigger), optimistic concurrency, append-only audit timeline, assignment. | tests incl. 25-pair DB-vs-code check |
| AI analysis | **Mandatory** (OpenAI key required); runs for every incident; result is written onto the incident. | **Optional** (off by default); advisory only: a responder must click "Apply"; strict schema; one in flight per incident; re-run with history. | `analysis.int.test.ts`, `openai-provider.test.ts` |
| Durable processing | Postgres write, then enqueue to Redis/BullMQ (a dual write); startup sweep re-queues QUEUED/PROCESSING jobs. | Job row committed in the same transaction as the incident; lease + fenced completion; no Redis needed. | outbox, fencing, SKIP LOCKED tests |
| External context | Bounded GitHub issue search for context. | **Not implemented** (a gap). | – |
| Real-time | Client polling every 2.5 s while pending. | Same approach (poll only while pending). Socket.IO not yet built. | e2e polling step |
| Deployment evidence | Live Railway deployment, Dockerfile, CI workflow with Postgres/Redis. | Docker Compose for dev and a CI workflow exist from Phase 1 but have not been run since Milestone 1; **no live deployment**. | – |
| Test evidence | About 25 backend and 9 frontend test cases (Vitest, mocked Prisma/queue in places). | Counts above, against real PostgreSQL through a `psql` adapter, plus a headless-browser flow; **Jest, the `pg` pool and `next build` not yet run**. | ADR 0008 |

Honest reading: this project is ahead on access control, auditability, data integrity and test depth; the reference is ahead on proven deployment, GitHub enrichment and a smaller surface that is known to run. "Better" is not claimed until the unrun checks pass on a normal machine and a deployment exists.

## Decisions

- **Postgres-native job queue instead of BullMQ now.** Adding Redis/BullMQ needs new dependencies and a lockfile regeneration that was impossible in this environment, and the guarantee we care about (no lost or double-processed work between "saved" and "queued") is achievable on PostgreSQL alone: `jobs` row written in the business transaction; claim = one `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)`; lease expiry for crashed workers; completion fenced on (job, worker, status). Delivery is at-least-once, so the handler is idempotent (its write is conditional on the analysis still being open). **Interview concepts: transactional outbox, SKIP LOCKED work queues, leases and fencing tokens, at-least-once vs exactly-once.** Limits: polling (2 s) rather than push, one table shared by all job types, no priority or rate limiting, no dead-letter UI (dead rows are queryable: `status = 'dead'`).
- **AI is a replaceable adapter behind a validated boundary.** The provider returns raw JSON; the handler validates it with a strict Zod schema (no extra keys, bounded lengths, fixed severities) before anything is stored; raw model text is never copied into job errors or API responses; failures are exposed only as one of four codes. OpenAI is called through `fetch` (no SDK dependency) with Responses-API structured output and `store: false`. The base URL is constructor-only so a configuration error cannot redirect the API key. `AI_PROVIDER=gemini` is accepted by the config but not implemented: the feature stays off, and config now reports an explicit disabled reason even if a Gemini key is supplied.
- **Prompt injection stance.** The incident text is sent as a JSON string value, the instructions say it is untrusted data, and only title/description/severity/status are sent (no emails, names, organization or ids). This reduces but cannot remove injection risk; the real controls are the output schema, plain-text storage and rendering, and the human "Apply" step. The system prompt uses the same "treat external text as untrusted evidence" idea as the reference; no code or text was copied from it.
- **Privacy.** Enabling AI sends incident text to the configured provider. This is documented in `docs/DEVELOPMENT.md`; there is no per-organization opt-in yet (a limitation).

## Acceptance criteria and results

| # | Criterion | Result (sandbox harness against PostgreSQL 16) |
|---|-----------|-----------------------------------------------|
| 1 | Incident + job commit atomically; failure after insert leaves neither | passed (`outbox:` test); mutant enqueuing outside the tx fails it |
| 2 | Two workers, 40 jobs: each exactly once; two workers, 10 incidents: provider called exactly 10 times | passed |
| 3 | Retry with attempts counted, then dead; permanent failure dead after 1; retry not run before its delay | passed |
| 4 | Expired lease is taken over; late result of the old owner is discarded; exhausted job is reaped, owner told | passed; mutant removing the fence fails the test |
| 5 | AI off: nothing queued, API says disabled, re-run refused 409 | passed |
| 6 | Output validation: injected/extra-key/oversized output rejected, never stored, not echoed in errors | passed; mutant without validation fails |
| 7 | One analysis in flight per incident, also under 6 parallel requests (DB partial unique index) | passed |
| 8 | Tenant isolation, role checks (viewer read-only), Origin check on the new endpoint | passed |
| 9 | Provider failures (401/429/5xx/timeout/refusal/garbage) classified; key never in body or error | passed against a local fake HTTP server |
| 10 | UI: pending state, polling without reload, text-only rendering, apply-severity audited, no injected DOM node | passed (33/33 browser steps) |

**Not verified:** the real OpenAI API (no network access; request shape follows the documented Responses API but has not been exercised live; the default model name is unverified), NestJS wiring of the worker lifecycle, behaviour with the real `pg` pool, Jest.

## Reliability correction and Milestone 3 runtime work

The exhausted-lease reaper claims one candidate per transaction using `FOR UPDATE SKIP LOCKED`, repeatedly, skipping jobs whose finalization already failed in the current pass. Job state transition and the handler's terminal analysis update remain atomic. A failed callback rolls back only that job's finalization; the worker logs the error and still claims other work instead of letting one poison job starve the queue. Real PostgreSQL regression tests cover repeated finalization failures, healthy-job progress, consistent recoverable state, later finalization after the callback recovers, and a poisoned job at the head of the line not blocking other exhausted jobs (ADR 0014).

Milestone 3 adds a Nest E2E test using the actual controllers, HTTP middleware, session cookie, real `pg` pool and worker lifecycle. It directs the fixed OpenAI provider request through an injected test fetch transport to a local deterministic Responses mock—no real OpenAI request or production endpoint override. The workflow registers a user, creates an incident, completes analysis, requests a second analysis, applies the suggested severity through the standard API update, and verifies the audit timeline.

Production Dockerfiles for API and Next.js web, a Compose `app` profile and Docker image builds in GitHub Actions were added. **These new Milestone 3 tests, Docker builds and CI workflow require execution after delivery; source presence is not a passed result.**
