# 0006 Transactional outbox and idempotent queue processing (Phase 4)

**Problem in the reference.** It wrote to the database and then enqueued to Redis (a dual write) and used a recovery sweep for the gap. A crash between the two loses or duplicates work.

**Decision.**
- Producers insert an `outbox_events` row in the **same transaction** as the business change.
- A relay claims rows with `FOR UPDATE SKIP LOCKED`, enqueues to BullMQ using the outbox id as the BullMQ `jobId` (so re-enqueue is a no-op), then marks them published.
- Consumers are idempotent: a `processed_events (consumer, event_id)` primary key makes the side effect and the "processed" record one transaction; a duplicate delivery hits the key and is skipped.
- Retries use BullMQ attempts with exponential backoff; poison events go to a failed set and are visible in an admin query.

**Tests required before Phase 4 is accepted:** relay crash after enqueue before mark-published (duplicate enqueue, single effect); consumer crash before commit (retry, single effect); concurrent relays (each event claimed once); transient Redis outage (events remain pending, then drain).

**Status.** The Redis/BullMQ relay described above is still NOT implemented. Milestone 2 (ADR 0012) implements the transactional-outbox guarantee directly on PostgreSQL instead: the job row is written in the business transaction, workers claim it with `FOR UPDATE SKIP LOCKED` and a lease, and completion is fenced. That removes the dual write for the AI analysis without Redis. BullMQ remains an option if cross-service fan-out or rate-limited external APIs justify it; the tests listed above that concern Redis (relay crash, Redis outage) do not apply to the Postgres queue and are not claimed.
