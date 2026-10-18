# Incident resolution API

The session-authenticated routes follow the API's existing `/api/incidents` prefix:

- `GET /api/incidents/:id/resolution` reads the current resolution and returns `404` if the incident has none.
- `POST /api/incidents/:id/resolution` creates the current resolution and returns `201`.
- `PUT /api/incidents/:id/resolution` replaces its root cause and fix using `expectedVersion`, returning `200`.

The read response is an `IncidentResolutionDto` containing the incident id, root cause, fix applied, resolver, version, and timestamps. It requires incident read access; organization scope is derived from the session. Writes require `rootCause` and `fixApplied` as nonblank strings of at most 2,000 characters. The create body accepts only those two fields. The update body additionally requires a positive `expectedVersion`. Unknown properties—including organization, resolver, and caller-supplied version fields—are rejected. The authenticated membership supplies `resolvedBy` and the organization scope.

Writes require responder permission or higher. Creating a second current resolution returns `409 CONFLICT`; updating a missing resolution returns `404`; a stale `expectedVersion` returns `409 VERSION_CONFLICT`. Each successful create or edit increments the resolution version and writes a `resolution_changed` timeline event in the same transaction. Resolution text remains optional when an incident is transitioned to `resolved`.

The web resolve flow reads the current resolution after an ambiguous create failure. It continues only if the saved text exactly matches the submitted text; a different saved resolution is never overwritten.

## Similar incidents

`GET /api/incidents/:id/similar` is available to any authenticated organization member with incident read access. It derives organization scope from the session and returns up to five resolved incidents in that organization, excluding the requested incident. Search uses its title, description, and available resolution text against the English weighted full-text documents. Punctuation separates identifier tokens (for example, `QRS-9087` can match `QRS/9087`); at most 12 distinct terms are used.

The response is `{ "results": [...] }`. Each result contains `id`, organization-local `number`, `title`, `severity`, `resolvedAt`, nullable `rootCause` and `fixApplied`, and `matchedTerms` (the sanitized source terms that matched the candidate's English search vector). Results are ranked by PostgreSQL text-search relevance, with resolution time and incident number as deterministic tie-breakers. A source with no searchable terms, or with no matches, returns `{ "results": [] }`. A missing, malformed, or cross-organization source incident follows the existing `404 NOT_FOUND` behavior.
