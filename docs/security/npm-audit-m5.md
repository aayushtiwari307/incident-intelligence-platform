> **Historical pre-Step1 assessment (2026-10-24).** This report describes the old lockfile before Multer 2.5.0 / Zod 4.6.7 were installed and verified by the owner on Windows. Do not treat its “unresolved” table as current status. See [`../../STEP1-REPORT.md`](../../STEP1-REPORT.md) and [`../../CODING-COMPLETION-REPORT.md`](../../CODING-COMPLETION-REPORT.md) for current evidence and final-tree verification limits. `NPM-AUDIT-PRE-STEP1.json` is historical evidence only.

# Dependency security re-review — 2026-10-24

**Historical pre-Step1 finding (2026-10-24).** This document describes the vulnerable dependency tree before the owner performed the Step 1 remediation on Windows. Do not use its locked versions or audit conclusion for the current candidate. The earlier audit file has been renamed `NPM-AUDIT-PRE-STEP1.json`. See [`../../STEP1-REPORT.md`](../../STEP1-REPORT.md) for the verified Step 1 result and [`../../CODING-COMPLETION-REPORT.md`](../../CODING-COMPLETION-REPORT.md) for the remaining verification limits after feature integration.

## Locked dependency evidence

| Package entry | Locked version / path | Finding | Decision |
|---|---|---|---|
| `multer` | 2.4.0, transitive through pinned `@nestjs/platform-express@11.2.7` | High: GHSA-q7qp-rjg7-q26m / CVE-2026-113872 affects `>=2.0.0 <2.5.0`; patch 2.5.0. The audit also has an `@nestjs/platform-express` aggregate entry for this same Multer advisory; it is not a separate issue. | Unresolved. Source grep found no `FileInterceptor`/Multer upload usage, lowering current-code reachability, but the installed dependency is still vulnerable if a multipart path is added or reached. Registry was unreachable; do not guess parent patches or lockfile content. |
| `zod` | 3.25.76 direct and root override | High: GHSA-mrhx-c7xc-m3w5 / CVE-2023-54404; current advisory says versions below 4.6.6 are affected. | Unresolved. Patched line is Zod 4; moving all API/shared/web/test schemas across major-version semantics is not safe without dependency installation and regression tests. The existing override to 3.25.76 does not remediate it. |
| `body-parser` | 2.4.0 in the resolved lockfile | GHSA-27r3-jxmh-p828 / CVE-2026-111181 affects 2.x below 2.4.0 and is patched in 2.4.0. | This specific advisory is resolved in the lockfile, but no fresh install/audit was possible. Do not count it as a third outstanding high finding. |

The current Multer advisory describes a denial of service under an asynchronous `fileFilter` after request teardown and recommends 2.5.0+. Zod's current advisory describes memory exhaustion for oversized arrays under `<4.6.6`. `body-parser`'s current advisory says 2.4.0 is patched. Sources: [Multer advisory](https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [body-parser advisory](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828).

## Three evidence-based paths attempted

1. **Static manifest + lockfile inspection:** confirmed `@nestjs/platform-express@11.2.7`'s exact Multer resolution is 2.4.0, root override resolves Zod to 3.25.76, and body-parser resolves to 2.4.0. The package lock was not edited.
2. **Advisory + reachable-code review:** checked the current upstream advisories and grepped the source for `FileInterceptor`, Multer imports, and multipart upload paths. No project Multer upload endpoint was found. This does not make the dependency safe if used by framework middleware or future features; retain the finding.
3. **Registry / dependency-tree commands:** npm registry metadata access failed with `EAI_AGAIN registry.npmjs.org`. Without `node_modules`, `npm ls` / `npm explain` cannot provide a fresh installed-tree report, and `npm ci` cannot reproduce the lockfile. Do not infer success.

No `npm audit fix --force` was used. No speculative override or major Zod migration was applied because neither could be validated. The project has no uploaded file path using Multer today, but the deployable dependency remains part of the resolution graph. A patched Nest platform-express release or a tested root Multer override should be preferred once registry access is available; it must be followed by `npm ci`, `npm ls multer`, relevant API tests and `npm audit`. Zod needs a deliberate v4 migration plan with schema-by-schema parity evidence.

## Commands to run from Windows CMD after registry access returns

```cmd
npm ci
if errorlevel 1 exit /b 1
npm ls multer zod body-parser --all
if errorlevel 1 exit /b 1
npm explain multer
npm explain zod
npm explain body-parser
npm audit --json > npm-audit-final.json
if errorlevel 1 echo npm audit reports findings or failed; inspect npm-audit-final.json and the command output
```

Keep `npm-audit-final.json` outside source control unless deliberately reviewed for publication. Historical conclusion for the pre-Step1 snapshot only: two independent high advisories were unresolved; the Nest platform-express row was an aggregate of the Multer issue; body-parser 2.4.0 was patched for its named advisory.
