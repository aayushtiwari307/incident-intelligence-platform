# Incident Intelligence Platform

Incident operations platform: NestJS API, Next.js web app, PostgreSQL, a PostgreSQL-backed durable job queue, and optional AI assistance.
Current status (2026-10-24): a low-volume public demo is deployed on Render Free with Neon PostgreSQL. The homepage, `/health/live`, and `/health/ready` returned HTTP 200 in live checks. This is a demo deployment, not a production or uptime guarantee. Core accounts, organizations, roles, invitations, incident lifecycle, audit timeline, and the durable PostgreSQL job queue are implemented.

## Milestone status

- **M1–M4 — Core platform:** Implemented. Live incident creation, status transitions, and timeline updates were manually verified on 2026-10-24.
- **M5 — Real-time updates:** Implemented in source but disabled in the current deployment. Two-browser live verification remains pending. See `docs/verification/milestone-5-status.md`.
- **M6 — Free deployment:** Render and Neon deployment is working; live health checks passed. Backup/restore drill and the public registration policy decision remain pending. See `docs/deployment/m6-free-deployment.md`.
- **M7 — Alert intake and deduplication:** Merged and included in the deployed application. The verification record documents candidate integration tests and synthetic simulator checks. A real external Alertmanager deployment remains untested, and rate limiting is in-memory per process. See `docs/verification/milestone-7-status.md`.
- **M8 — Similar incidents:** Implemented without requiring AI. See the M8 verification and evaluation documents for recorded evidence and limitations.
- **M9 — Grounded AI suggestions:** The local verification record reports 445 unit tests and 257 PostgreSQL integration tests passing, along with typecheck, lint, builds, and migration checks. No live AI-provider request has been verified; AI remains disabled in the deployed service. See `docs/verification/milestone-9-status.md`.

**Still not implemented:** GitHub issue enrichment. Real-time and live AI verification remain outstanding.

## Requirements
Node >= 22.12 (see `.nvmrc`), Docker, npm 10+.

## Getting started
Step-by-step instructions for Windows **CMD and PowerShell** (env files, starting the API and web app in two
terminals, health endpoints, tests, troubleshooting) are in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md).

Short version, from the repository root:
```
npm ci
npm run setup:env
npm run services:up
npm run dev:api      # terminal 1
npm run dev:web      # terminal 2
npm run health
```

## Full production-container smoke environment

After creating the root `.env`, run `docker compose --profile app up -d --build --wait` to build and start PostgreSQL, the NestJS API and the Next.js web app. Open `http://127.0.0.1:3000`. Stop containers with `docker compose --profile app down`; this does not remove the database volume. The default `npm run services:up` behavior remains database dependencies only. With the stack up, `npm run smoke:stack` runs an HTTP and WebSocket smoke test (health, web page, auth, incidents, CSRF origin check, session revocation, realtime delivery and isolation) against it. The Compose profile and the CI job that runs this are implemented in source but remain unverified until the first actual Docker/CI run succeeds. The production API uses a `Secure` `__Host-` session cookie: browse the container stack at `http://127.0.0.1:3000` (localhost-class hosts only).

## Checks
```
npm run check:deps && npm run check:hygiene
npm run typecheck && npm run lint && npm test
npm run test:integration     # needs TEST_DATABASE_URL, see docs/DEVELOPMENT.md
```

## Layout
- `apps/api` NestJS API, SQL migrations in `apps/api/migrations`
- `apps/web` Next.js app
- `packages/shared` Zod schemas shared by both
- `docs/integrations` integration guides (Alertmanager)
- `docs/decisions` architecture decision records, `docs/spikes` evidence for them

No licence has been chosen for this project's own code yet (owner decision).

To run the same stack behind the local single-origin proxy: `docker compose -f docker-compose.yml -f docker-compose.edge.yml --profile app up -d --build --wait`, then browse `http://127.0.0.1:8080` (see `docs/DEVELOPMENT.md`).
