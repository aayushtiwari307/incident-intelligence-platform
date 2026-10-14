# Dependency audit record, Milestone 5 (R7)

**Status: BLOCKED in the authoring sandbox. `npm audit` was NOT run.** The sandbox's egress policy answered HTTP 403 for `registry.npmjs.org`, and the audit endpoint lives there. No finding below is an audit result; nothing is claimed about vulnerabilities.

## What was done instead (offline, reproducible)

- Removed `ioredis@5.11.1` (zero imports anywhere in the repository; see ADR 0017). `npm uninstall ioredis -w @platform/api --package-lock-only --offline` rewrote the lockfile; the diff removes `ioredis` and the seven packages only it needed (`@ioredis/commands`, `cluster-key-slot`, `denque`, `redis-errors`, `redis-parser`, `standard-as-callback`, plus the workspace dependency line). `debug` stays (used by others). Fewer packages is a smaller audit surface, nothing more.
- No other dependency was added, upgraded or removed. No `npm audit fix` was run.

## What you run (Windows PowerShell, from the repository root)

```
npm ci
npm audit --omit=dev            # what ships in the images
npm audit                       # including dev tooling
npm audit --json > audit.json   # keep outside the repository / do not commit
```

## Review procedure and decision table (fill in from real output)

For each finding record: package, severity, direct or transitive, whether the vulnerable code path is reachable here, decision.

| Package | Severity | Path (direct / via) | Reachable? | Decision |
|---|---|---|---|---|
| *(none recorded yet)* | | | | |

Rules: do not run blind `npm audit fix` or `--force`; prefer pinning a patched version that the parent allows; a breaking major upgrade needs its own change, tests and ADR. The M3 maintainer report already listed 20 moderate findings and deprecation warnings that were never itemized; they belong in this table too. Socket.IO 4.8.4 (and its `engine.io`, `ws`, `socket.io-parser` transitives) arrived in M4 and are the first rows to check.

Also still outstanding and unrelated to `npm audit`: a dependency **licence** audit (`THIRD_PARTY_NOTICES.md`).
