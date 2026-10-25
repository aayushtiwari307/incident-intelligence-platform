> **Historical staged report.** This file describes the earlier stage snapshot and its checks. The latest implementation/status and current final-tree verification boundary are recorded in the root [`CODING-COMPLETION-REPORT.md`](../../CODING-COMPLETION-REPORT.md). Do not use older test counts or dependency statements here as current final-tree evidence.

# Coding stage report 4 — M10 service and change context

**Evidence status:** implemented in source; PostgreSQL integration/runtime and realtime delivery untested.

**Changes:** design note `docs/design/m10-service-change-context.md`; migration `0014_service_change_context.sql`; service DTO/schema exports; `ServiceCatalogService`, `ChangeWebhookHandlers`, authenticated HTTP controllers/module registration; Alertmanager service matching; services page and incident detail enrichment panel; `scripts/simulate-change.mjs` and tests; integration regression suite.

**Behavior implemented:** tenant-scoped service catalog and composite tenant foreign keys; incidents link to a local service; Alertmanager may bind a service using a same-organization service name; change webhook requires a hashed bearer integration of kind `change-events`, bounded one-event schema/body/time, request/IP/integration in-memory rate limits, and idempotency by organization/source/external ID; correlation only returns same-tenant/same-service changes at or before incident creation and no older than 24 hours, latest first, labelled `correlation, not proven cause`; change timeline notification uses the existing `incident_events` + `LISTEN/NOTIFY` path. Simulator refuses non-loopback by default.

**Executed:** root script suite passed, including local simulator safety tests. It does not run the TypeScript integration suite.

**Not run:** migration or integration tests; no Docker/PostgreSQL server or dependencies were available. No GitHub/network call or hosted DB operation was made.

**Decision/risk:** M10 is **implemented, awaiting verification**. Run API unit/type checks and PostgreSQL integration tests on a disposable loopback database; apply migrations 0013/0014 there only first. Do not test against Neon production.
