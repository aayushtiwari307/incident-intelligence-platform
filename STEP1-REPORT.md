# Step 1 — Dependency security remediation and Zod 4 compatibility

Date: 2026-10-25

## Changes

- Root npm overrides pin `multer` to `2.5.0` and `zod` to `4.6.7`; `apps/api` and `packages/shared` depend on Zod 4.6.7 directly.
- The committed lockfile resolves Multer 2.5.0 with the authentic SHA-512 integrity fetched from the npm registry and Zod 4.6.7 with integrity metadata.
- Environment issue formatting was migrated to Zod 4 issue shapes without echoing rejected values.
- Alertmanager status/version validation uses Zod 4 custom-error configuration. Its stable 413 response for batches over 50 was preserved, with a schema-level limit as defense in depth.
- Regression assertions now inspect validation-detail message fields rather than stringifying JSON and accidentally asserting escaped quote sequences.

## Windows verification reported by the project owner

On the extracted Step 1 working copy, the owner supplied PowerShell output showing:

- `npm ci` succeeded and installed 547 packages.
- `npm ls multer zod body-parser --all` resolved `multer@2.5.0` (overridden), `zod@4.6.7` (overridden) and `body-parser@2.4.0`.
- `npm audit` reported `found 0 vulnerabilities`.
- `npm run typecheck` and `npm run lint` passed.
- Unit tests passed: API 273/273 and web 75/75; the complete `npm test` command reached the green completion message.
- PostgreSQL integration tests passed 258/258 across 20 suites against a separate disposable local PostgreSQL container.
- `npm run build` passed.

The focused Alertmanager regression test also passed 19/19 after its assertions were corrected.

**Scope caveat:** the above Windows checks were run on the Step 1 working copy before the newly integrated GitHub and M10 feature code in this final archive. They are not evidence that all new features have passed the same suite.

## Final integrated source: checks run in authoring container

- `node --test "scripts/*.test.mjs"`: **82 passed, 0 failed** on the current source tree.
- Isolated pure-logic checks for strict timestamp validation/correlation, GitHub quota/circuit behavior, text hygiene and bounded buckets: **16 passed**.
- TypeScript syntax parsing: **185 `.ts`/`.tsx` files parsed, zero syntax diagnostics**. Repository hygiene in the ZIP/source-tree mode passed with **319 files checked**. This is a syntax check, not a semantic typecheck.
- `npm ci` could not finish in this container because requests to `registry.npmjs.org` returned `EAI_AGAIN`. No full final-tree Jest suite, semantic typecheck, lint, build or PostgreSQL migration/integration suite was run here.

## Security references

- Multer: https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m (fixed in 2.5.0)
- Zod: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 (patched release line includes 4.6.6; selected 4.6.7)

No commit, push, deployment, live GitHub request, or production database access was performed.
