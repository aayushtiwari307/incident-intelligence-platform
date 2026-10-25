# Realtime rollout checklist

**Current state (2026-10-24): implemented in source; production configuration and public acceptance are unverified in this review. Keep realtime disabled until each step below is complete.**

## Configuration

1. Confirm the application’s normal `DATABASE_URL` works for ordinary queries/migrations. Do not change it for realtime.
2. In the deployment provider's private environment settings, set `REALTIME_DATABASE_URL` to the direct PostgreSQL endpoint for the intended database (not a pooler hostname). Never paste this value into source control, tickets, screenshots, chat or logs.
3. Set `REALTIME_ENABLED=true` only after the dedicated direct URL is set. The API configuration rejects an enabled listener without this URL and rejects obvious `pooler` hostnames. A string check cannot prove every provider-specific endpoint is direct, so verify it in the database provider's dashboard.
4. Redeploy through the normal owner-controlled release process and confirm startup/health logs contain no connection string. This assistant did not change deployment settings or deploy this snapshot.

## Acceptance

- [ ] Health endpoints report ready after startup; ordinary incident CRUD and migrations still use the normal query pool.
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
