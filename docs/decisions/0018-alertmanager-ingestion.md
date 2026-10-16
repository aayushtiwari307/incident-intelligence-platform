# 0018: Alertmanager ingestion and alert-cycle deduplication (Milestone 7)

Status: implemented in source 2026-10-16; **not accepted** (see `docs/verification/milestone-7-status.md`).

## Decisions
1. **Own bearer credential, not the session.** Integrations are organization-scoped rows with a SHA-256-hashed token shown once. The webhook ignores cookies and Origin. Management endpoints stay session + Origin protected and need the new `integration:manage` permission (admin).
2. **Identity = integration id + fingerprint + normalized startsAt**, never `groupKey`. Rotation updates the hash in place so the id (and history) is stable. A UNIQUE constraint is the last line of defence.
3. **Concurrency:** one transaction per delivery; `SELECT … FOR SHARE` on the integration row (a concurrent revoke/rotate waits, later deliveries get 401); a per-integration `pg_advisory_xact_lock` serializes deliveries; `INSERT … ON CONFLICT DO NOTHING` with a retryable 503 if the backstop ever fires; deterministic batch order; `SET LOCAL lock_timeout = '5s'`.
4. **Reuse the incident lifecycle** through `IncidentService.createFromAlert/resolveFromAlert` (shared `changeStatus`). No new event type, so no CHECK change; actor is `alertmanager: <name>` with a null actor id.
5. **Status codes follow upstream Alertmanager retry semantics** (only 5xx retried): backpressure is 503 + Retry-After, truncation is 503, oversize and too-many-alerts are 413.
6. **Own body reader** and limit (`WEBHOOK_BODY_LIMIT_BYTES`, default 1 MiB), run after authentication; the global JSON parser skips `/api/v1/integrations/*`.
7. **Bounded projection:** only the fields listed in `docs/integrations/alertmanager.md` are stored; raw bodies and arbitrary labels never are.
8. **In-memory rate limits**, documented as per process (no Redis, budget ₹0).

## Rejected
- groupKey identity (changes when group membership changes). Reopening resolved incidents on stale firings. 429 for rate limiting (not retried by Alertmanager). Application-only dedupe without a constraint. Persisting the raw payload.

## Consequences
Migration `0007_alert_integrations.sql` (tables `integrations`, `alert_cycles`). An unseen resolved cycle is persisted as a tombstone (`incident_id IS NULL`), preventing delayed firing notifications for that identity from creating a phantom incident.
