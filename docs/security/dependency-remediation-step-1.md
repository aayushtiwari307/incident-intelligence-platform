# Dependency remediation — Step 1 (2026-10-25)

**Status:** the dependency fix was installed and checked on the owner's Windows Step 1 working copy. The full integrated GitHub/M10 source still needs its final test cycle, but the dependency tree itself was not changed during feature integration.

## Changes

- Root npm overrides pin `multer` to `2.5.0` and `zod` to `4.6.7`; API/shared direct Zod references are also `4.6.7`.
- The lockfile resolves the Multer 2.5.0 tarball with the official registry SHA-512 integrity and Zod 4.6.7 integrity.
- Zod 4 issue formatting is handled without echoing rejected environment values.
- Alertmanager custom messages use Zod 4's error option. Regression checks inspect the structured `message` field, not JSON-stringified details. The early >50 alerts guard continues to return the existing 413 behavior.

## Windows evidence reported by the owner

From the extracted Step 1 working copy, the owner supplied output showing:

- `npm ci` succeeded (`added 547 packages`).
- `npm ls multer zod body-parser --all` resolved `multer@2.5.0` and `zod@4.6.7` via the overrides, with `body-parser@2.4.0`.
- `npm audit` reported `found 0 vulnerabilities`.
- Typecheck and lint passed; API unit tests were 273/273; web unit tests 75/75; integration tests 258/258 across 20 suites; and `npm run build` passed.
- The Alertmanager focused regression suite passed 19/19 after the validation-error assertion fix.

These checks happened before the GitHub/M10 feature integration in the current archive. Run the final integrated tree's suite again before release.

## Security references

- Multer advisory: https://github.com/expressjs/multer/security/advisories/GHSA-q7qp-rjg7-q26m (patched in 2.5.0)
- Zod advisory: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 (patched release line includes 4.6.6; selected 4.6.7)

The pre-Step1 audit JSON is retained as `NPM-AUDIT-PRE-STEP1.json` for historical comparison only. It must not be read as the current dependency audit.

No force-fix was run. No Nest downgrade was made. No production database, commit, push or deployment was touched.
