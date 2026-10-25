> **Historical staged report.** This file describes the earlier stage snapshot and its checks. The latest implementation/status and current final-tree verification boundary are recorded in the root [`CODING-COMPLETION-REPORT.md`](../../CODING-COMPLETION-REPORT.md). Do not use older test counts or dependency statements here as current final-tree evidence.

# Coding stage report 3 — GitHub issue enrichment

**Evidence status:** implemented in source; Jest/API and browser verification untested.

**Changes:** `docs/design/github-issue-enrichment.md`, additive migration `0013_github_issue_enrichment.sql`, `packages/shared/src/services.ts` and exports, `apps/api/src/github/github-issue.service.ts`, `apps/api/src/http/api.controllers.ts`, `apps/api/src/http/api.module.ts`, `apps/web/src/lib/api-client.ts`, `apps/web/src/app/github/page.tsx`, `apps/web/src/components/incident-enrichment-panels.tsx`, incident detail/nav integration, and `apps/api/src/github/github-issue.service.test.ts`.

**Controls implemented:** explicit per-organization opt-in; repository allow-list management requiring integration management permission; identifiers are schema validated; endpoints are constructed on the fixed `https://api.github.com` host; redirects are manual and not followed; short timeouts; bounded response body, labels, comments and text; ETag conditional caching; per-organization outbound-request limits (each issue/comment GET counts), a per-process outbound-request budget, and a concurrency cap; generic unavailable/private states; DB queries filter tenant; no token setting or AI forwarding; React renders remote text as text.

**Executed:** the root JavaScript regression suite passed as described in the overall report. No test in this suite exercises the TypeScript GitHub service.

**Not run:** TypeScript/Jest tests, migration, API runtime, browser UI, or real GitHub requests (deliberately none made by tests or this review). Dependencies were unavailable.

**Decision/risk:** code and tests are present, but acceptance remains **implemented, awaiting verification**. The schema migration must run through the project migration process in a disposable DB first, then staged deployment.
