# Third-party notices

## Reference project: ai-incident-intelligence

Parts of this repository were adapted from <https://github.com/julmtoz/ai-incident-intelligence>
(MIT, Copyright (c) 2026 Julio Matos). The full licence text is in
[`LICENSES/reference-ai-incident-intelligence-MIT.txt`](LICENSES/reference-ai-incident-intelligence-MIT.txt)
and must be kept with any copy of the adapted material.

Items adapted so far (this list is kept truthful and updated as more is reused):

| Here | Adapted from | Change |
|------|--------------|--------|
| `docker-compose.yml` healthcheck commands | reference `docker-compose.yml` | new ports (loopback, 5434/6380), required passwords |
| `.dockerignore` | reference `.dockerignore` | trimmed to this layout |
| `apps/api/src/common/shutdown.ts` | reference `backend/src/lib/shutdown.ts` | timeout is a parameter |
| `apps/api/src/config/redact.ts` | reference `sanitizedString` | broadened patterns, URL and key-based redaction |

Everything else (workspace layout, env validation, migration runner, SQL schema, shared schemas, scripts) was written for this project.

## Runtime and development dependencies

Dependencies are distributed under their own licences; see `package-lock.json` and run
`npx license-checker` locally. A dependency licence audit has **not** been performed yet.

Milestone 4 adds `socket.io` and `socket.io-client` (both MIT, maintained by the Socket.IO team, installed from npm, not copied into this repository). No source from the reference project or from Socket.IO was reused; the real-time layer was written for this project.

Milestone 5 removes `ioredis` (and its transitive packages) and adds an optional runtime container image, `caddy:2.8.4-alpine` (Caddy is Apache-2.0), used only by `docker-compose.edge.yml` as a local reverse proxy. It is pulled from Docker Hub at run time, not copied into this repository. The licence audit above is still not performed.
