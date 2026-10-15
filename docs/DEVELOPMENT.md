# Development setup on Windows (CMD and PowerShell)

> **Milestone 5 (2026-10-14):** Redis is no longer part of the stack; the web/API can also run behind a local single-origin proxy (see "Single-origin proxy topology"). M5 paths are unverified until run on Windows/CI.
>
> Native development and test commands were verified on Windows against Milestone 2.1. Milestone 3 adds a true Nest E2E test and production container path; those newly added paths remain unverified until they pass locally/CI. If a step behaves differently, report the exact command and result.

Commands are shown for **CMD** and **PowerShell** where they differ; where only one block is shown it works in both.
Run everything from the repository root unless stated otherwise.

## 0. Prerequisites

| Need | Check | Notes |
|------|-------|-------|
| Node.js 22.12+ | `node -v` | `.nvmrc` pins 22 |
| npm 10+ | `npm -v` | ships with Node 22 |
| Docker Desktop, **running** | `docker version` shows a *Server* section | PostgreSQL runs in a container |
| Free ports | 5434, 3001, 3000 (8080 for the proxy topology) | the containers publish on 127.0.0.1 only |

**PowerShell only:** if `npm` fails with "running scripts is disabled on this system", either use `npm.cmd` instead of `npm`,
or run once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## 1. Install dependencies

```
npm ci
```

The root `package-lock.json` is part of the source repository. Use `npm install` only when intentionally changing dependencies; review and commit its lockfile changes.

## 2. Create the environment files (once)

```
npm run setup:env
```

This creates three git-ignored files from their `.example` templates and generates random passwords that match
between them. It never overwrites an existing file and never prints a password.

| File | Used by | Contains |
|------|---------|----------|
| `.env` | Docker Compose | `POSTGRES_*` |
| `apps/api/.env` | the API | `DATABASE_URL` (same password), `CORS_ORIGINS`, ... |
| `apps/web/.env.local` | Next.js | `NEXT_PUBLIC_API_URL` only |

Never put a secret in `apps/web/.env.local`: every `NEXT_PUBLIC_*` value is visible to every visitor.
`npm run check:hygiene` fails if a secret-looking name appears there.

Edited the passwords by hand later? Keep the root `.env` and `apps/api/.env` in sync, then recreate the containers
(the database keeps its first password in its volume): `npm run services:reset` (**this deletes the local database data**).

## 3. Start PostgreSQL

```
npm run services:up
```

Waits until the container is healthy. Check: `docker compose ps` shows `healthy` for `postgres`. (An old `redis` container from before M5 may linger; `docker compose up` warns about orphans and it is harmless. `REDIS_URL` is optional and unused.)
Stop with `npm run services:down` (data is kept in Docker volumes).

## 4. Start the API (terminal 1)

```
npm run dev:api
```

What it does: builds `packages/shared`, compiles the API, then runs it and restarts on changes.
With `MIGRATE_ON_START=apply` (the development default) it applies pending migrations on startup and refuses to
start if a migration fails or the database does not match the code.

You should see JSON log lines ending with `"message":"listening"` on `127.0.0.1:3001`.

## 5. Start the web app (terminal 2, a second window)

```
npm run dev:web
```

Open <http://127.0.0.1:3000> (use exactly this host name, not `localhost`: the session cookie is `SameSite=Lax`, and
`localhost` vs `127.0.0.1` are different sites, so sign-in would seem to work and the next request would be 401).
You land on the sign-in page. Choose **Create an organization**, register, and you are the owner.

Try the workflow: open an incident, acknowledge it, comment, change severity/assignee, resolve it. To test roles, go to
**Team**, invite a second email as *viewer*, copy the one-time token, register that email in a private window and paste
the token under **Accept an invitation**. If requests fail with a network error, the API is not running or the origin
you opened is not in `CORS_ORIGINS` (it is also the CSRF allow-list for sign-in, sign-out and every write).

**AI analysis (optional).** Leave `AI_PROVIDER=none` and everything except the "AI analysis" panel works. To try it, set
`AI_PROVIDER=openai` and `OPENAI_API_KEY` in `apps/api/.env` (never in the web env files), restart the API, open an
incident: an analysis is queued when an incident is created and a responder can re-run it. The worker runs inside the API
process; look for `job worker started` in the log. Incident text is sent to the provider you configure.

Optional settings in `apps/api/.env`: `SESSION_TTL_HOURS` (default 168), `INVITE_TTL_HOURS` (default 168), `AI_MODEL`, `AI_TIMEOUT_MS`, `REALTIME_ENABLED` (default true) and `REALTIME_REVALIDATE_SECONDS` (default 10).

## 6. Check health

```
npm run health
```

prints one line per endpoint and exits non-zero if either fails. Equivalent manual calls:

| | CMD | PowerShell |
|---|-----|-----------|
| liveness | `curl http://127.0.0.1:3001/health/live` | `curl.exe http://127.0.0.1:3001/health/live` |
| readiness | `curl http://127.0.0.1:3001/health/ready` | `curl.exe http://127.0.0.1:3001/health/ready` |

(In Windows PowerShell 5.1 plain `curl` is an alias of `Invoke-WebRequest`; use `curl.exe` or `Invoke-RestMethod`.)

| Endpoint | Meaning | Healthy | Unhealthy |
|----------|---------|---------|-----------|
| `GET /health/live` | the process is up; never touches dependencies | `200 {"status":"ok"}` | no response |
| `GET /health/ready` | the database answers | `200 {"status":"ok","database":"up"}` | `503 {"status":"unavailable","database":"down"}` |

## 7. Migrations by hand

```
npm run build -w @platform/api
npm run migrate            # apply pending migrations
npm run migrate:status     # verify only: fails if any are pending, edited, missing or out of order
```

## 8. Run the checks

```
npm run typecheck
npm run lint
npm test
```

Integration tests need a real PostgreSQL and **fail (never skip)** without `TEST_DATABASE_URL`. Milestone 3 adds a NestJS HTTP-to-AI test intended to boot the actual Nest module/controllers, real `pg` pool and worker lifecycle, and redirect the OpenAI fetch transport to a deterministic local Responses mock. This new test has not yet been run against the real Windows/Jest stack. Tests create and drop
their own uniquely named databases, so the role needs `CREATEDB` (the compose user has it). Use the `POSTGRES_PASSWORD`
value from your `.env`:

| CMD | PowerShell |
|-----|-----------|
| `set TEST_DATABASE_URL=postgres://platform:YOUR_PASSWORD@127.0.0.1:5434/postgres` | `$env:TEST_DATABASE_URL = "postgres://platform:YOUR_PASSWORD@127.0.0.1:5434/postgres"` |
| `npm run test:integration` | `npm run test:integration` |

## Run the full production-container stack

The default `npm run services:up` starts only PostgreSQL so Windows development can run the API and web natively. To build and run the full production container stack, first create the root `.env` with `npm run setup:env`, then run:

```powershell
docker compose --profile app up -d --build --wait
```

Open `http://127.0.0.1:3000`. The API container applies pending migrations at startup and health-checks `/health/ready`; the web container health-checks `/login`. Optional AI configuration comes from the root `.env` (`AI_PROVIDER=openai`, `OPENAI_API_KEY`, and optionally `AI_MODEL`). AI remains disabled by default.

Stop the application containers without deleting the database volume:

```powershell
docker compose --profile app down
```

With the containers running, `npm run smoke:stack` exercises the real API and web over HTTP (it registers throw-away users, so use it only against local/CI stacks). Since M5 it also opens real Socket.IO connections: unauthenticated and foreign-Origin refusal, `realtime.ready`, delivery of a REST-created incident within 5 s, cross-organization isolation and socket closure after logout. `SMOKE_REALTIME=off` skips those checks. Output never contains incident text. Percent-encode special characters in `POSTGRES_PASSWORD` or avoid them: the compose file interpolates it into `DATABASE_URL`.

Do not use `npm run services:reset` for routine shutdown; it removes Compose volumes and deletes local database data.

## Live updates (Milestone 4)

The API serves Socket.IO on the same port (`/socket.io`, WebSocket only). Open two browser windows at `http://127.0.0.1:3000` signed in to the same organization (a second user can be invited on the Team page), open the incident list in both, create or comment on an incident in one: the other updates without a reload and shows "Live" next to the heading. Do not use `localhost` for one and `127.0.0.1` for the other: the session cookie is host-specific and the socket handshake checks `Origin` against `CORS_ORIGINS`.

Milestone 4 added `socket.io` and `socket.io-client`; the committed lockfile contains them (use `npm ci`). Apply migration 0006 (`npm run migrate`, or restart the API with `MIGRATE_ON_START=apply`).

## Single-origin proxy topology (Milestone 5)

A Caddy container serves the web app and the API from one origin so the `SameSite=Lax` cookie, the Origin check and WebSockets behave as they would behind a real production domain. Only the proxy is published (`127.0.0.1:8080`); the API and web ports are not.

```powershell
docker compose -f docker-compose.yml -f docker-compose.edge.yml --profile app up -d --build --wait
$env:API_URL = "http://127.0.0.1:8080"; $env:WEB_URL = "http://127.0.0.1:8080"
npm run smoke:stack
docker compose -f docker-compose.yml -f docker-compose.edge.yml --profile app down
```

`/api/*`, `/socket.io` and `/health/*` go to the API, everything else to the web app. The override sets `TRUST_PROXY_HOPS=1` (the proxy overwrites client `X-Forwarded-*` headers). In this topology the browser uses same-origin relative REST and WebSocket URLs, so the frontend no longer has a public API hostname baked into its bundle. The API Origin allow-list stays explicit: by default it is `http://127.0.0.1:8080`; when using an HTTPS tunnel, set `PUBLIC_ORIGIN` to the exact new URL before recreating the API container, for example:

```powershell
$env:PUBLIC_ORIGIN = "https://your-current-name.trycloudflare.com"
docker compose -f docker-compose.yml -f docker-compose.edge.yml --profile app up -d --wait api
```

Replace the example with the actual tunnel URL (scheme and hostname only, no path). No web rebuild is needed when the tunnel hostname changes. If you change `EDGE_PORT`, also set `PUBLIC_ORIGIN` to the corresponding local origin. The proxy speaks plain HTTP internally; the public tunnel supplies HTTPS. Keep `TRUST_PROXY_HOPS=0` whenever nothing sits in front of the API.

Optional: `REDIS_URL` may be set but nothing uses it. Negative control for the realtime checks: start the API with `REALTIME_ENABLED=false` and run `npm run smoke:stack`; it must fail at a `realtime:` check.

## Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `Invalid environment configuration` listing variables | `apps/api/.env` missing or incomplete: run `npm run setup:env`. Values are never echoed. |
| `password authentication failed` | root `.env` and `apps/api/.env` passwords differ, or the volume was created with older ones: `npm run services:reset` |
| `ECONNREFUSED 127.0.0.1:5434` | container not running: `npm run services:up`; start Docker Desktop first |
| `migration CHECKSUM_MISMATCH` | an applied migration file was edited. Never edit applied migrations; add a new numbered one. |
| `LOCK_TIMEOUT` | another API/migrate process is mid-migration; wait or stop it |
| Port 3001 or 3000 already in use | stop the other process; change `API_PORT` / the web `--port` and `CORS_ORIGINS` together |
