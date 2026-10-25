# GitHub issue enrichment — design before implementation

## Scope and data model

- `organization_github_settings`: one row per organization; explicit opt-in is required before repositories can be used.
- `github_repositories`: tenant-scoped owner/repository allow-list. A repository name is data, not a URL; the client cannot choose a host or scheme.
- `github_issue_links`: one bounded issue/PR link per incident, scoped by both organization and incident. Cache the issue projection, a small recent-comments projection, ETags, fetch time, and a non-sensitive failure category. Never store or return an authorization token.

## Endpoints

- `GET /api/organization/github`: read opt-in state and this tenant's linked repositories.
- `PUT /api/organization/github`: owner/admin enables or disables the integration.
- `POST /api/organization/github/repositories` and `DELETE /api/organization/github/repositories/:id`: owner/admin allow-list public repository identifiers.
- `POST /api/incidents/:id/github-issue`: responder+ links an issue number to an allow-listed repository.
- `GET /api/incidents/:id/github-issue`: responder+ reads cached safe fields; a bounded conditional refresh is attempted only when stale.
- `DELETE /api/incidents/:id/github-issue`: responder+ removes the incident link.

## External request policy

- Construct URLs only as `https://api.github.com/repos/{validated-owner}/{validated-repo}/issues/{number}` and its `/comments?per_page=5` child. Do not accept client URLs, custom hosts, redirects, or arbitrary path fragments. Use `redirect: "manual"`, short abort timeouts, `Accept`, and a fixed User-Agent.
- Public unauthenticated API only. Private repositories intentionally degrade to a generic unavailable state; no token is needed or supported. Respect `ETag` / `If-None-Match`, cache results, rate-limit each tenant, cap process-wide concurrent refreshes, and never retry a rate-limited response in a tight loop.
- Allow only opted-in tenant repositories and verify that each repository and incident belongs to the authenticated session's organization. Owner/admin is required to manage the repository allow-list and opt-in.
- GitHub titles, labels, body excerpts, assignee names, and comments are untrusted display data. Bound lengths and counts, strip control characters, render as text (never HTML/Markdown injection), never put external text into an AI prompt, and never treat it as instructions.

## Tests

Use a fake database surface and injected fetch implementation; never call real GitHub from tests. Cover strict owner/repo/issue parsing, no custom-host/redirect following, opt-in and role gates, cross-tenant 404s, cache/304 behavior, concurrency/rate limits, timeout, 403/404/429/5xx, malformed JSON, bounded output, and absence of secrets in DTOs.
