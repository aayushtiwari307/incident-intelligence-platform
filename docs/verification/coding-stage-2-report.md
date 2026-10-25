> **Historical staged report.** This file describes the earlier stage snapshot and its checks. The latest implementation/status and current final-tree verification boundary are recorded in the root [`CODING-COMPLETION-REPORT.md`](../../CODING-COMPLETION-REPORT.md). Do not use older test counts or dependency statements here as current final-tree evidence.

# Coding stage report 2 — M5/M6 closeout

**Evidence status:** source implementation and root script regression tests; live and PostgreSQL listener checks untested.

**Changes:** `apps/api/src/config/env.ts`, realtime connector, config tests, listener integration fixture, `.env.example`, `apps/api/.env.example`, `docs/deployment/realtime-rollout.md`, and the registration/source evidence notes.

**Behavior:** realtime is disabled by default; `REALTIME_ENABLED=true` requires `REALTIME_DATABASE_URL`; it never falls back to the ordinary query-pool `DATABASE_URL`. The obvious `pooler` hostname is refused and diagnostics use redacted URLs. Existing listener retry/backoff and reconnect resync logic were retained. Production registration rejects public self-registration in source while the invite registration path and sign-in remain separate. The live Render setting and live registration flow were not inspected or changed.

**Executed:** `node --test scripts/*.test.mjs` — exit 0, 62 tests passed, 0 failed (root JavaScript `.mjs` script suite only; TypeScript/Jest realtime config and listener tests were not run because dependencies are unavailable).

**Not run:** Jest config/listener tests, database integration tests, direct listener runtime, realtime WebSocket smoke against deployment, two-browser acceptance, or live registration test. Dependencies were absent and registry failed; no local PostgreSQL or live deployment access was used.

**Decision/risk:** leave realtime off until owner completes [`realtime-rollout.md`](../deployment/realtime-rollout.md). The source guard does not prove what is configured on Render.
