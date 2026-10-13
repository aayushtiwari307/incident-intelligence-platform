# 0007 The reference's Vite 500, and how the new frontend is validated

**Record.** A Vite HTTP 500 on the reference project's dev server was reported earlier. During the audit it was **not independently reproduced**, so it is neither confirmed nor dismissed. Vite is being replaced by Next.js, so no time is spent patching it.

**Requirement that follows.** A production build is not evidence that the dev server works. For `apps/web` the following must be run and recorded in the phase report, in a real browser:
1. `npm run dev -w @platform/web`, open `/` , confirm HTTP 200 and no console errors
2. a client-side navigation and a hard reload of a nested route
3. the API call from the browser succeeds through CORS with the configured origin
4. `npm run build -w @platform/web` and `next start`, same checks
5. Playwright scripts for the above once the UI has real flows (Phase 6)

**Status in Phase 1.** `apps/web` is a minimal shell. **It has not been started or built here** (Next.js could not be installed in the sandbox), so none of the checks above have been performed.
