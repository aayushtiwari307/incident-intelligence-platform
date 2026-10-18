# M6 — Free public demo deployment

**Status:** local deployment configuration only. No provider resources have been created and no live service has been launched.

## Architecture

Use one Render Free Docker web service and a new Neon Free PostgreSQL project:

```text
Browser
  └─ HTTPS → Render edge → Caddy (Render PORT)
                 ├─ /api/*, /socket.io/*, /health/* → NestJS on 127.0.0.1:3001
                 └─ all other paths → Next.js on 127.0.0.1:3000
NestJS → Neon PostgreSQL
```

This single origin preserves the existing HttpOnly session-cookie behavior. The production API sets a `Secure`, `SameSite=Lax`, `Path=/` `__Host-sid` cookie; browser REST and optional WebSocket requests stay on the frontend origin. Caddy preserves the browser `Origin` and cookie headers. The runtime derives the exact Render HTTPS origin from Render's documented `RENDER_EXTERNAL_URL` and adds it to the API origin allow-list; `CORS_ORIGINS` may add additional exact origins. No wildcard is used. API proxy trust is set to one hop because only Caddy can reach the loopback-bound API.

`/health/live` is a database-free liveness check for Render. `/health/ready` remains available for an operator smoke test and checks PostgreSQL. Using liveness for Render's periodic probe avoids waking Neon just to check database readiness.

`AI_PROVIDER=none` disables AI without needing a provider key. With AI disabled, the API does not start the job worker. `REALTIME_ENABLED=false` prevents the persistent PostgreSQL `LISTEN` connection and Socket.IO service. The web bundle disables Socket.IO and refreshes incident state through REST immediately and every 30 seconds.

`REDIS_URL` is optional and unused: there is no Redis client or Redis-backed feature in the API.

## Current free-plan limitations (checked 2026-10-18)

These providers can change their terms; re-check the linked official pages before account setup. This design is for a low-volume demo, not production or guaranteed uptime.

- **Render Free web service:** Render explicitly says Free instances are not for production. A Free web service spins down after 15 minutes without inbound traffic and can take about a minute to restart. Free instances share a 750-hour monthly workspace allowance; if it is exhausted, Render suspends Free web services until the next month. Without a payment method, exhausting included bandwidth suspends Free services instead of charging for overage. Free services have 512 MB RAM and ephemeral filesystems; local files are not durable. The combined API, web server, and proxy share that memory limit and may be suspended or OOM-killed. Do not add a payment method or upgrade to bypass a limit.
- **Neon Free:** the pricing page currently lists no credit card requirement, 100 CU-hours per month per project, 1 GB database storage per project, and compute sizes up to 2 CU. Free compute scales to zero after five minutes inactive. Track actual project usage and keep its database within the free limits; exceeding a quota must not trigger an upgrade or billing change.
- The Render Free service and Neon Free database are independently managed. Neither supplies high availability, a wake-time guarantee, or a durable filesystem for uploads.

Sources: [Render Free instances](https://render.com/docs/free), [Render web services](https://render.com/docs/web-services), [Render Docker](https://render.com/docs/docker), [Render Blueprint specification](https://render.com/docs/blueprint-spec), [Neon pricing](https://neon.com/pricing), [Neon connection strings](https://neon.com/docs/connect/connect-from-any-app), [Neon connection pooling](https://neon.com/docs/connect/connection-pooling).

## Files added or updated

- `Dockerfile` — multi-stage shared/API/Next production build and non-root runtime; includes Caddy as the only public listener.
- `deploy/render/Caddyfile` — same-origin API, Socket.IO, health, and frontend routing.
- `scripts/deploy/combined-runtime.mjs` — starts API and web, waits for liveness, then starts Caddy; propagates termination and fails the container if a child exits unexpectedly.
- `scripts/deploy/runtime-config.mjs` — validates the public port, binds API to loopback, configures the one trusted proxy, and derives the Render origin.
- `scripts/deploy/runtime-config.test.mjs` — tests public port, proxy/origin configuration, and invalid Render origins.
- `render.yaml` — a Free Docker service, liveness health path, and disabled automatic deploys. It only describes a service; it does not provision or deploy it.
- `.dockerignore` — excludes environment files, backups, the diagnostic archive, and audit report from Docker build context.
- `apps/web/src/lib/realtime-client.ts`, `apps/web/src/lib/use-realtime.ts`, `apps/web/src/lib/realtime-client.test.ts`, and `apps/web/.env.example` — REST fallback when public realtime is disabled.

Existing API health behavior, migration CLI, authentication, CSRF/origin checks, and secure-cookie policy are reused; they are not bypassed.

## Build and runtime contract

The build starts from the repository root with Node 22 and the committed `package-lock.json`:

1. `npm ci --no-audit --no-fund`
2. `npm run build -w @platform/shared`
3. `npm run build -w @platform/api`
4. `NEXT_PUBLIC_API_URL="" NEXT_PUBLIC_REALTIME_ENABLED=false npm run build -w @platform/web`
5. `npm prune --omit=dev --no-audit --no-fund`

Dockerfile stages perform these steps and ship only production output/dependencies. The final image uses Node 22, Caddy 2.8.4, and the `node` non-root user. `PORT` selects Caddy's public listener (defaults to 10000 locally); the API and web servers bind only to `127.0.0.1:3001` and `127.0.0.1:3000`. Caddy serves health and API routes through NestJS and everything else through Next.js. Its reverse proxy supports WebSocket upgrades if realtime is enabled in a future deployment.

Required service environment:

| Variable | Value / handling |
| --- | --- |
| `DATABASE_URL` | Neon **pooled** PostgreSQL URL at runtime, copied from Neon; configure as a Render secret, never commit or print it. |
| `NODE_ENV` | `production` |
| `MIGRATE_ON_START` | `check`; API refuses to serve if the database cannot connect or has pending/inconsistent migrations. |
| `AI_PROVIDER` | `none`; do not set an AI key. |
| `REALTIME_ENABLED` | `false` |
| `TRUST_PROXY_HOPS` | Runtime enforces `1` behind Caddy. |
| `CORS_ORIGINS` | Optional extra exact HTTPS origins. Render's primary `RENDER_EXTERNAL_URL` is added automatically. No wildcard. |
| `PORT` | Provided by Render; do not set manually in Render. Caddy uses it. |
| `LOG_LEVEL` | `info` (default if omitted). |

No environment file or credential is passed as a Docker build argument. The root Dockerfile does not copy `.env` files; runtime secrets are injected by the host. API logs redact the database URL and keys; Caddy access logging is not enabled.

## Database and migration lifecycle

Realtime is disabled, so the deployed API does not use PostgreSQL `LISTEN`/`NOTIFY`. Normal API transactions—including transaction-scoped advisory locks—can use Neon's pooled endpoint. The migration runner's **apply** mode uses a session advisory lock, so run the one-time migration with Neon's **direct, non-pooled** URL. Do not run automatic migration apply at service startup.

For a future approved deployment:

1. In Neon, create a **new empty Free project/database**. Do not point this app at an existing database. Use the project Connect dialog to copy both URLs: pooled for Render runtime, direct (pooling disabled) for the migration command. Keep TLS parameters such as `sslmode=require` intact.
2. From a local checkout containing the exact reviewed migrations (including 0011), build shared/API, then run the real migration CLI against the new database:

   ```powershell
   npm run build -w @platform/shared
   if ($LASTEXITCODE -ne 0) { throw "Shared build failed" }
   npm run build -w @platform/api
   if ($LASTEXITCODE -ne 0) { throw "API build failed" }

   $hadDatabaseUrl = Test-Path Env:DATABASE_URL
   $previousDatabaseUrl = $env:DATABASE_URL
   $secureUrl = Read-Host "Paste the Neon direct DATABASE_URL" -AsSecureString
   $bstr = [IntPtr]::Zero
   try {
     $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureUrl)
     $env:DATABASE_URL = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
     npm run migrate -w @platform/api
     if ($LASTEXITCODE -ne 0) { throw "Database migration failed" }
   } finally {
     if ($hadDatabaseUrl) { $env:DATABASE_URL = $previousDatabaseUrl }
     else { Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue }
     if ($bstr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
     $secureUrl.Dispose()
     Remove-Variable previousDatabaseUrl, secureUrl, bstr -ErrorAction SilentlyContinue
   }
   ```

   The URL is entered as a secure prompt, inherited only by this process and its npm/Node child, and the previous process-level variable is restored even after failure. The CLI prints migration names/status, not the connection string.
3. Verify the new database with `npm run migrate:status` using the same safe environment-variable procedure and direct URL.
4. Configure Render's `DATABASE_URL` secret with the Neon **pooled** URL. Keep `MIGRATE_ON_START=check`; startup remains fail-closed and never applies pending migrations.
5. After the provider assigns the service URL, confirm it is HTTPS and that Render's `RENDER_EXTERNAL_URL` matches the intended public origin. If using a custom domain, add that exact HTTPS origin to `CORS_ORIGINS`.

No Neon URL is included in this repository, and no remote connection or migration was made during this task.

## Local verification and smoke procedure

Docker Desktop must be running. These commands build and start a disposable local demo stack only when you choose to run them; do not run against an existing/unidentified database:

```powershell
docker build -t incident-platform-m6:local .
docker run --rm --name incident-platform-m6 `
  -p 127.0.0.1:10000:10000 `
  -e PORT=10000 `
  -e DATABASE_URL `
  -e MIGRATE_ON_START=check `
  -e AI_PROVIDER=none `
  -e REALTIME_ENABLED=false `
  -e CORS_ORIGINS=http://127.0.0.1:10000 `
  incident-platform-m6:local
```

Supply `DATABASE_URL` from a separately created disposable test database in the process environment before running the container. The image exits rather than serving if the API or web process fails to become ready. Verify:

```powershell
Invoke-RestMethod http://127.0.0.1:10000/health/live
Invoke-RestMethod http://127.0.0.1:10000/health/ready
Invoke-WebRequest http://127.0.0.1:10000/login
```

Then register/sign in, create an incident, reload its detail, and verify incident/timeline data persists in the disposable PostgreSQL database. Send Ctrl+C and confirm the container stops its child processes. To test missing mandatory configuration, start the image without `DATABASE_URL`; it must exit non-zero before opening the public listener. Do not use the local Compose volume, a developer database, or the Neon demo database for this test.

For a future hosted acceptance test, verify `/health/live`, sign-up/sign-in and logout cookie flags, create/list/reload an incident, confirm same-origin writes pass strict Origin validation, and check logs for startup/readiness without secret values. Do not treat a green health response alone as a deployment acceptance test.

## Manual steps and safe recovery

- This change did not create a Neon project, Render service, billing profile, or live URL. Do not add a payment card, enable billing, upgrade, or continue if the provider asks for payment.
- The M8 changes and migrations in this worktree are uncommitted. **Do not create a Render service from the current GitHub branch yet**: it would not contain the reviewed local changes. After separate approval, commit/push the intended reviewed snapshot, verify its exact commit, and only then create a Render Free service with the Blueprint. Automatic deploys are disabled in `render.yaml`.
- If Render sleeps, wait for its cold start; do not upgrade to avoid it. If a free quota is exhausted, wait for reset rather than enabling paid usage.
- If readiness fails, inspect redacted startup logs, verify `DATABASE_URL` and that migration status is current, and correct configuration. Never reset/drop the database to make startup pass. Apply only forward migrations through the documented CLI after confirming the target is the newly created demo database.
- Monitor Neon storage/compute quotas and Render free instance hours. If the demo reaches a free limit, pause the demo; do not enable billing or migrate data as part of an automatic recovery.
