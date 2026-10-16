# Alertmanager integration (Milestone 7)

`POST /api/v1/integrations/alertmanager` accepts standard Prometheus Alertmanager **webhook v4** notifications and turns them into incidents, with deduplication. No paid service, Redis or AI is involved.

## 1. Credentials

An owner or admin creates an integration on the **Team** page (or `POST /api/organization/integrations`, session + Origin protected). The API returns a bearer token **once**; only its SHA-256 hash is stored. Lost token: rotate.

| Action | Endpoint (session auth, owner/admin only) | Effect |
|--------|-------------------------------------------|--------|
| list | `GET /api/organization/integrations` | metadata only, never a token |
| create | `POST /api/organization/integrations` `{ "name": "prod" }` | 201 + token (once). Max 20 active per organization |
| rotate | `POST /api/organization/integrations/:id/rotate` | new token (once); the old one stops working immediately. The integration id, and therefore the dedupe history, is unchanged |
| revoke | `DELETE /api/organization/integrations/:id` | soft revoke; the token stops working immediately, history is kept |

The webhook accepts the token **only** in `Authorization: Bearer <token>`. Query strings and cookies are never read; the browser Origin/CSRF check does not apply (no browser) and the browser endpoints never accept this token. Authorization headers are not logged. The organization is taken from the integration row, never from the request.

## 2. Alertmanager configuration

Put the token in a file readable by Alertmanager (do not paste it into the YAML or commit it):

```yaml
receivers:
  - name: incident-platform
    webhook_configs:
      - url: https://YOUR-HOST/api/v1/integrations/alertmanager
        send_resolved: true
        max_alerts: 0            # 0 = never truncate (see section 6)
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/incident-platform.token
```

## 3. Payload

Standard v4 JSON (`Content-Type: application/json`):

```json
{
  "version": "4",
  "groupKey": "{}:{alertname=\"HighErrorRate\"}",
  "status": "firing",
  "receiver": "incident-platform",
  "alerts": [{
    "status": "firing",
    "labels": { "alertname": "HighErrorRate", "severity": "critical", "job": "api" },
    "annotations": { "summary": "5xx above 5%", "description": "Error ratio is 7%" },
    "startsAt": "2026-10-16T08:00:00.000Z",
    "endsAt": "0001-01-01T00:00:00Z",
    "fingerprint": "3a1f9c0d2b7e4a55"
  }],
  "truncatedAlerts": 0
}
```

Validated strictly and bounded: version `"4"`, 1 to 50 alerts, fingerprint `[A-Za-z0-9._:-]{1,128}`, RFC 3339 timestamps, bounded label/annotation counts and lengths, no prototype-pollution keys. Unknown top-level fields (e.g. `externalURL`, `commonLabels`) are ignored.

**Persisted** per incident: a title (`alertname: summary`, max 200), a severity, and a description built from `summary`, `description` and a fixed allow-list of labels (`alertname, severity, job, instance, namespace, service, cluster, env`), all value-bounded, control/bidi characters stripped and secret-looking text masked. **Not persisted:** the raw body, other labels/annotations, URLs, `groupKey`, `externalURL`.

### Severity mapping

| Label `severity` (case-insensitive) | Incident severity |
|---|---|
| critical, page, emergency, fatal, sev1, p1 | sev1 |
| error, major, high, sev2, p2 | sev2 |
| warning, warn, medium, sev3, p3 | sev3 |
| info, informational, minor, low, none, debug, sev4, p4 | sev4 |
| missing / anything else | sev3 |

## 4. Deduplication

One **alert cycle** = (integration id, `fingerprint`, `startsAt` normalized to UTC, microsecond precision). `groupKey` is never used. A database UNIQUE constraint on that triple is the final guarantee.

| Delivery | Result | Effect |
|---|---|---|
| first `firing` for a cycle | `created` | one incident, timeline events `created` (actor `alertmanager: <name>`) |
| repeated `firing` (Alertmanager repeats every `repeat_interval`) | `duplicate` | counters only; no event, no notification |
| `resolved` for a firing cycle | `resolved` | incident moved to resolved with a `status_changed` event |
| repeated `resolved` | `duplicate_resolved` | nothing |
| `resolved` for a cycle never seen | `ignored_unknown_resolution` | a resolved tombstone is saved; nothing is created |
| `firing` for an already resolved cycle | `ignored_stale_firing` | never reopens |
| same fingerprint, new `startsAt` | `created` | a new cycle, a new incident |

If a human already resolved the incident, the incoming resolution is acknowledged and adds no event; the cycle is still marked resolved, so later deliveries of it stay deduplicated.

A delivery is **one transaction**: either every alert in it is applied or none, and 2xx is returned only after COMMIT. A per-integration advisory lock serializes concurrent deliveries so concurrent identical requests create exactly one incident and overlapping batches cannot deadlock.

## 5. Responses and retries

Alertmanager treats 2xx as delivered, retries **only 5xx** (and connection errors) by default, and does **not** retry 4xx or 429. This is why backpressure here is 503 with `Retry-After`, never 429.

| Status | Code | Meaning | Retried by Alertmanager |
|---|---|---|---|
| 200 | | committed, including duplicates and ignored cycles. Body lists a per-alert `result` | n/a |
| 400 | `VALIDATION_FAILED` | malformed JSON or payload | no (fix the sender) |
| 401 | `UNAUTHENTICATED` | missing, wrong or revoked token | no |
| 413 | `PAYLOAD_TOO_LARGE` | body above `WEBHOOK_BODY_LIMIT_BYTES` (default 1 MiB), or more than 50 alerts | no |
| 415 | | not `application/json` | no |
| 503 | `SERVICE_UNAVAILABLE` (with `Retry-After`) | rate limit, database unavailable, lock timeout | yes |
| 503 | `ALERTS_TRUNCATED` | `truncatedAlerts > 0`, so the notification is incomplete | yes (the sender must be fixed, see below) |

Oversize returns 413 deliberately: it is deterministic, retrying cannot succeed, and the response says how to fix it.

## 6. Truncation and `max_alerts`

If Alertmanager's `max_alerts` is non-zero and a group has more alerts, it sends only the first N and sets `truncatedAlerts`. Applying a partial notification would silently lose alerts (and a partial resolve would be wrong), so the API refuses it with 503 `ALERTS_TRUNCATED` and creates nothing. Remedy: set `max_alerts: 0` **and** make groups at most 50 alerts with a finer `group_by` (for example `[alertname, instance]`; `group_by: ['...']` disables grouping entirely). Groups above 50 alerts are rejected with 413.

## 7. Rate limits (per process, in memory)

Counters live in the API process and reset on restart; with several API instances each has its own budget (no Redis by design). Limits: 600 requests/minute per client IP; 20 failed credential attempts per 5 minutes per IP (then 503 before any database lookup); 300 deliveries/minute per integration. Behind a proxy set `TRUST_PROXY_HOPS` correctly or every client shares one IP bucket.

## 8. Known limitations

- A first-seen `resolved` notification is stored as a tombstone with no incident. Later deliveries for the same `(integration, fingerprint, startsAt)` stay deduplicated; a different `startsAt` is a new cycle.
- Only Alertmanager v4 is supported; there is no per-integration routing, no label-based grouping of different alerts into one incident, and no retention job for `alert_cycles`. Tombstones share the same retention characteristics as other cycle rows.
- Rate limits are not distributed.
- Edge limits: `deploy/edge/Caddyfile` sets no request body limit; the API enforces its own.

## 9. Local simulator

`scripts/simulate-alertmanager.mjs` sends a synthetic firing, an identical firing, a resolved notification, and an invalid-bearer probe with an empty alerts array. It checks 11 expectations, including that the invalid credential receives HTTP 401 with `UNAUTHENTICATED`. The probe uses an empty alert list so an authentication regression cannot create a second synthetic incident. The simulator is **loopback-only** by default and uses only fake data.

```
set ALERTMANAGER_SIM_TOKEN=<token created on the Team page>
npm run simulate:alertmanager -- --base-url http://127.0.0.1:8080
```

Use `--allow-non-loopback` only for a host you own. The token is read from the environment, never printed, and never accepted as an argument.
