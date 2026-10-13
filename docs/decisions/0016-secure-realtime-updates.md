# 0016 Milestone 4: secure real-time incident updates (Socket.IO)

**Status: implemented in source. Not yet run against real Socket.IO, real PostgreSQL, Jest or CI. Built on the Milestone 3 candidate, which is itself not accepted (see PROJECT_MEMORY.md).**

## What it does

Signed-in users see incident changes (created, status, severity, assignee, edits, comments) appear without reloading. Everything still works without it: the REST API stays the source of truth and the pages fall back to ordinary requests. Switch it off with `REALTIME_ENABLED=false`.

## Protocol (`packages/shared/src/realtime.ts`)

Server to client only. There is **no client-to-server message** that selects an organization, an incident or a room.

| Event | Meaning | Client action |
|---|---|---|
| `realtime.ready` | authenticated and subscribed | reload REST state, show "Live" |
| `incident.event` | one committed timeline entry plus the incident's state at delivery time | merge by event id, keep the higher incident `version` |
| `realtime.resync` | the server cannot guarantee it delivered everything | reload REST state |

## Security model

1. **Authentication at the handshake.** The session cookie (the same opaque token and the same `AuthService.authenticate` as HTTP) is read from the upgrade request. No cookie, unknown token, revoked/expired session, disabled user: refused with `connect_error` data `{code}` before any socket exists. No token is ever placed in a URL, query string or JavaScript-visible storage.
2. **Cross-site WebSocket hijacking.** Browsers do not apply CORS to WebSockets and attach cookies to same-site origins (for example another port on `127.0.0.1`). `allowRequest` checks the `Origin` header against `CORS_ORIGINS` for every handshake; `Origin: null` and unlisted origins are refused. A missing Origin (non-browser client) is allowed but still needs a valid cookie.
3. **Organization comes from the session, never the client.** The handshake binds `{sessionId, userId, organizationId}` from the database. The only room a connection joins is `org:<organizationId>`. The server registers no handler for client events, so `join`/`subscribe` attempts are ignored.
4. **Authorization.** A connection requires `incident:read` in its active organization (any role). The payload is exactly what the same member could read via `GET /api/incidents/:id/timeline`.
5. **Tenant-filtered delivery.** A notification only names an event id and organization. The API loads the entry with `WHERE organization_id = $1 AND id = $2` and broadcasts to that organization's room only. The notification payload is strictly validated (the organization id becomes part of a room name).
6. **Access ends when entitlement ends.** Connections are re-checked against the database in batch (`AuthService.resolveSessions`, same validity rules as `authenticate`): revoked/expired session, disabled user, removed member, or a changed active organization closes the connection. This runs immediately on the instance that handled logout / organization switch / invitation redemption / member removal (`onAccessChanged` hook) and otherwise every `REALTIME_REVALIDATE_SECONDS` (default 10), which is the worst-case window for changes made through another instance or directly in SQL. If the re-check itself fails three times in a row, every connection is closed (fail closed).
7. **Limits.** WebSocket transport only (no long-polling surface, no sticky sessions), `maxHttpBufferSize` 1 KiB, at most 10 connections per user, bounded delivery queue, client bundle not served.
8. **No connection state recovery.** Socket.IO's built-in recovery restores a reconnecting client's previous rooms without re-deriving them from its current session, which would defeat rule 3 after an organization switch or removal. Every reconnect is a fresh handshake.

## Delivery and recovery

- Migration `0006_incident_events_notify.sql` adds an `AFTER INSERT` trigger on `incident_events` that calls `pg_notify('incident_events', {"id","o"})`. NOTIFY is queued by PostgreSQL and delivered only if the transaction commits, in commit order. Because it is a trigger, every path that writes the timeline is covered (including member removal, which writes raw SQL).
- Each API instance keeps one dedicated `LISTEN` connection (`NotificationListener`, exponential backoff 0.5 s to 15 s, 30 s heartbeat). Each instance loads and broadcasts to **its own** sockets, so scaling out needs no Redis adapter and no sticky sessions.
- Notifications are processed strictly one at a time, so messages leave in commit order. Instances skip loading for organizations with no local connections.
- **Gaps are announced, never silently dropped.** If the LISTEN connection drops and returns, a load fails, an event is missing, a payload is malformed, or the backlog exceeds 500, the hub broadcasts `realtime.resync` and clients reload over REST.
- **Client reconnect.** Socket.IO reconnects transport failures with backoff; refusals that Socket.IO does not retry are retried by the client with growing delays, unless fatal (`UNAUTHENTICATED`, `NO_ORGANIZATION`, `FORBIDDEN`), in which case the app refreshes the session (and the user is sent to sign-in if it has ended). On every `realtime.ready` (first connect and each reconnect) the page reloads its REST state, so nothing missed while offline can persist.
- **Client correctness.** Snapshots apply only if their `version` is at least the current one; timeline entries merge by id. An edit form remembers the version it started from, so a live update never lets a save silently overwrite a colleague's change (the save is refused with the existing 409 path and a notice is shown).

## Rejected alternatives

- *Emit from application code after commit.* Loses events on a crash between commit and emit and does not reach other instances.
- *Poll `incident_events` by "id greater than cursor".* Identity values are assigned before commit, so a later-committing transaction with a smaller id is skipped forever. NOTIFY-by-id plus REST resync has no such gap.
- *Per-organization sequence for gap-free replay.* Would serialize all timeline writes per organization and risk lock-order deadlocks with the existing incident/counter locks; not worth it when a REST reload is cheap and correct.
- *`@nestjs/websockets` + `@nestjs/platform-socket.io`.* Extra dependencies for no gain here; Socket.IO attaches to the existing HTTP server through one thin file.
- *Redis adapter.* Not needed for the design above.

## Not included / known limits

- AI analysis status is still polled (2.5 s while queued/running); it does not use push.
- Revocation made through another instance or directly in SQL is enforced within `REALTIME_REVALIDATE_SECONDS`, not instantly.
- Handshake attempts are not separately rate-limited (each costs one session lookup, like an HTTP request).
- A client that never reloads state after `realtime.resync` (a modified client) only hurts itself.
- Reverse proxies must pass WebSocket upgrades and the `Origin`/`Cookie` headers; no proxy exists in the current Compose setup (browser connects to the API port directly).

## Verification status

See `PROJECT_MEMORY.md` section 5b for the exact record. In short: the framework-free core, listener, web state/client logic and config were run in a sandbox harness; the Socket.IO adapter, the SQL trigger, `resolveSessions`, `loadRealtimeMessage`, the Nest wiring and both integration suites (`realtime-data`, `nest-realtime`, `access-hook`) have **not** been executed. Dependencies (`socket.io@4.8.4`, `socket.io-client@4.8.4`) are pinned in `package.json` but `package-lock.json` has **not** been regenerated (no registry access); the manifest pins were updated to 4.8.4; run `npm install` once and commit the regenerated lockfile before `npm ci`/CI/Docker will work.
