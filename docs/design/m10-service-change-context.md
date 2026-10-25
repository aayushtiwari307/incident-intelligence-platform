# M10 — service and change context design

## Data model

- `services`: organization-scoped catalog (`name`, `owner_team`, tier `tier1|tier2|tier3`), unique by normalized name within a tenant.
- `incidents.service_id`: nullable reference constrained by `(organization_id, service_id)`, so a service from another tenant cannot be linked.
- `change_events`: organization + service, source + external id idempotency key, bounded `version`, `actor`, timestamp and small metadata. The integration bearer credential is hashed in storage and is never displayed again after creation.
- All migrations are additive after 0012. Existing migrations stay immutable.

## Endpoints

- `GET/POST /api/organization/services`; `PATCH/DELETE /api/organization/services/:id` for owner/admin catalog management.
- `POST /api/v1/integrations/changes` accepts one bounded change-event object per request with a bearer integration credential; source + external id is idempotent. The webhook body size is capped by the shared webhook-body limit.
- `GET /api/incidents/:id/service-context` returns the linked service and only changes attached to that service inside the 24-hour correlation window before incident creation, newest first. Every result is labelled `correlation, not proven cause`.
- The incident edit form supports linking a catalog service; alert ingestion may select a service only by an organization-local service name label.
- A local loopback simulator posts a fake change to the API and refuses non-loopback targets.

## Threat model and correctness boundaries

- Tenant identity comes only from the session membership or from the validated integration credential's stored tenant. No request body organization ID is accepted.
- Integration tokens are CSPRNG-generated and hashed before storage. Webhook body size, field sizes, timestamp range, request rate and concurrency are bounded; the endpoint accepts one event object per request (not a batch). Duplicate source/external IDs do not duplicate writes.
- Correlation is observational, not causative: only matching service, same organization, within the bounded look-back window before the incident start. Do not include other services, tenants, future events, or stale records beyond the window.
- New changes create lightweight timeline wake-up events for affected incidents through the existing append-only `incident_events` + `LISTEN/NOTIFY` path. Event payloads contain IDs only, never change text or credentials.

## Tests

Cover CRUD role checks, composite tenant FK behavior, linking and unlinking, integration authentication/revocation, idempotency under retries, payload and rate limits, correlation boundaries/order, service exclusion, change-event notification, and public REST isolation. Integration cases must use a disposable loopback PostgreSQL only; no Neon URL is ever used.
