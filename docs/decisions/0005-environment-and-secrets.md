# 0005 Environment, proxy trust, ports, secrets, optional AI

- **Validation.** `apps/api/src/config/env.ts` validates every variable with zod, reports all problems at once, and never echoes values. Blank counts as unset (Windows `set FOO=`).
- **TRUST_PROXY bug.** The reference used `z.coerce.boolean()`; `"false"` and `"0"` became `true`, silently trusting every `X-Forwarded-For`. Replaced by `TRUST_PROXY_HOPS` (integer). Legacy `TRUST_PROXY=false` is accepted; `true` is rejected with an explanation. Regression tests were mutation-checked (reintroducing the bug makes them fail).
- **Secrets.** Connection URLs and API keys are wrapped in `Secret` (redacted in JSON, string conversion and `util.inspect`). Logs use `describeConfig` and `redactValue`.
- **Ports.** Docker publishes PostgreSQL on `127.0.0.1:5434` and Redis on `127.0.0.1:6380` (different from the reference's 5433/6379, so both can run side by side). Passwords come from an untracked `.env`; compose refuses to start without them. The API host defaults to `127.0.0.1`.
- **Frontend.** `apps/web/.env.example` allows only `NEXT_PUBLIC_API_URL`. `npm run check:hygiene` fails on tracked `.env` files, archives, secret-looking `NEXT_PUBLIC_*` variables and credential patterns.
- **AI optional.** `AI_PROVIDER` defaults to `none`; a missing key disables AI features with a recorded reason and never stops startup.
