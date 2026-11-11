# Realtime rollout checklist

**Current repository state (2026-11-11): real-time is implemented but disabled in the Render configuration while acceptance remains incomplete. This change takes effect on the next deployment; an already-running Render instance is unchanged until redeployed.**

## Configuration

1. Confirm the application’s normal `DATABASE_URL` works for ordinary queries/migrations. Do not change it for realtime.
2. In the deployment provider's private environment settings, set `REALTIME_DATABASE_URL` to the direct PostgreSQL endpoint for the intended database (not a pooler hostname). Never paste this value into source control, tickets, screenshots, chat or logs.
3. Keep real-time disabled by default. Set `REALTIME_ENABLED=true` only after the dedicated direct URL is configured and the acceptance checks below pass. Set `NEXT_PUBLIC_REALTIME_ENABLED=true` at Next.js build time as well; the API and browser flags must agree. Compose passes the API setting into the frontend build automatically. The API rejects an enabled listener without the dedicated URL and rejects obvious `pooler` hostnames. Verify the endpoint in the database provider's dashboard.
4. Redeploy through the normal owner-controlled release process. Check startup logs for listener status without exposing connection strings. `/health/ready` verifies the normal database connection only; it does not prove the real-time listener is connected. Use the authenticated Socket.IO smoke script and acceptance checks below.

## Acceptance

- [ ] `/health/ready` reports normal database readiness; ordinary incident CRUD and migrations still use the normal query pool. Verify real-time listener connectivity separately.
- [ ] Two authenticated users in the **same** organization see a new incident event without refreshing.
- [ ] A different tenant sees no other tenant's event.
- [ ] After network disruption or free-tier sleep, reconnect succeeds, the listener's existing exponential retry backoff is observed, and the client resyncs safely without duplicated visible events.
- [ ] Sign out/revoke the session and confirm realtime revalidation stops delivery.
- [ ] Keep realtime off if any check fails; clients continue using REST polling/refresh behavior.

## Read-only smoke script

Run in a local CMD window with `IIP_SMOKE_URL` set to the API origin and `IIP_SMOKE_COOKIE` holding a valid authenticated session cookie for the test account. The cookie is a secret; do not share it or save it in a tracked file. Script output does not include it.

```cmd
set "IIP_SMOKE_URL=https://api.example.com"
set "IIP_SMOKE_COOKIE=__Host-sid=PASTE_TEST_SESSION_COOKIE_HERE"
npm run smoke:realtime
```

The script only checks the authenticated Socket.IO handshake/readiness and performs no writes. A smoke result does not replace the two-browser acceptance checklist above.
