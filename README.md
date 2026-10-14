# Incident platform (working title)

Incident operations platform: NestJS API, Next.js web app, PostgreSQL, a PostgreSQL-backed durable job queue, and optional AI assistance.
Early development. Implemented: accounts and organizations, roles, invitations, incident lifecycle with an audit timeline. Also implemented: a durable PostgreSQL job queue and optional AI incident analysis (off by default). The queue does not use BullMQ or Redis, and there is no Redis service (`REDIS_URL` is optional and unused). Implemented (merged in M4) but not yet verified at runtime in a real browser: secure Socket.IO real-time incident updates (ADR 0016). Milestone 5 (ADR 0017, `docs/verification/milestone-5-status.md`) adds WebSocket smoke checks, an optional single-origin proxy and audit records; it is implemented in source and **not accepted**. Not yet implemented: GitHub issue enrichment, or deployment. See `docs/decisions` (start with 0010) for what exists and what is explicitly not done.

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
- `docs/decisions` architecture decision records, `docs/spikes` evidence for them

No licence has been chosen for this project's own code yet (owner decision).

To run the same stack behind the local single-origin proxy: `docker compose -f docker-compose.yml -f docker-compose.edge.yml --profile app up -d --build --wait`, then browse `http://127.0.0.1:8080` (see `docs/DEVELOPMENT.md`).
