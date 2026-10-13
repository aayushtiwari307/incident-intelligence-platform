# 0002 Workspace layout and version pinning

**Layout.** `apps/api` (NestJS), `apps/web` (Next.js), `packages/shared` (Zod schemas, roles, and shared event/input types). One root `package-lock.json` is committed.

**Pinning.** Direct dependencies are pinned where practical; root `overrides` force a single `typescript`, `react`, `react-dom`, `@types/react`, `@types/react-dom` and `zod`. `npm run check:deps` checks the installed tree for duplicate versions of the watched packages.

**Choices that were not the newest:**
- NestJS 11.2.7 (CommonJS). Nest 12 is ESM-only, which would force ESM through Jest and ts-jest for no product benefit.
- TypeScript 5.9.3, because ts-jest compatibility is a constraint for this codebase.
- zod 3.25.76. Zod 4 changes the API and the integrations used here do not require it.

## Lockfile verification

The root lockfile is present in the Milestone 1 source. On the earlier Windows foundation copy, npm 10.9.3 successfully ran `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`, `npm ci --no-audit --no-fund` (525 packages installed), and `npm run check:deps` (no duplicates among watched packages). The root `package.json` declares `packageManager: npm@10.9.4`; the successful Windows install was run under npm 10.9.3, so those results prove the lockfile resolved under 10.9.3 but not that the exact declared npm version was used.

Those Windows results predate the Milestone 1 product implementation. Any subsequent package-manifest/lockfile changes must be installed and verified on the current source before release.
