# Current decision status (2026-10-24)

AI remains disabled by default in the current source. No Gemini adapter or live provider request was added during closeout: the provider adapter is not implemented in this snapshot, and data-use/training terms were not verified for a new free provider. The `gemini` config label therefore yields a disabled reason, not an operational provider. Fake/mock tests and historical OpenAI-adapter unit coverage are not live-provider evidence.

The remainder of this ADR is retained as the original M9 design/verification record and should be read with the current-snapshot evidence boundary in `../verification/milestone-9-status.md`.

---

# 0019. Grounded AI suggestions (Milestone 9)

Status: implemented in source 2026-10-18; **not accepted**. Testing deferred (see `docs/verification/milestone-9-status.md`).

## Context
M2 added an advisory AI analysis. M8 added tenant-scoped similar-incident retrieval. M9 combines them: a responder asks for a
suggestion, and the answer must be traceable to the incident and to similar resolved incidents of the same organization. The
project has a zero budget, so every automated check uses a fake provider and nothing here activates billing or a paid API.

## Decisions
- **Alias-based grounding.** The model sees the current incident as `S0` and at most five similar resolved incidents as `S1..S5`.
  It cites aliases, never database ids, so an invented id or another organization's id is simply an unknown alias and is rejected.
- **Provenance, not truth.** Each citation needs a sent alias and a quote that appears verbatim (NFKC, lower-cased, whitespace
  collapsed) in that source's redacted text. Quotes that are too short or only placeholders/labels are rejected. This proves where
  text came from; it does not prove the claim is correct, and the UI says "verify before use".
- **Strict structured output.** A strict Zod schema fixes the kinds (summary, severity, next steps, related incidents), caps sizes,
  rejects unknown keys and control characters, and returns failure reasons and paths only, never model text. Related-incident
  results contain aliases only; the server supplies a fixed M8-retrieval label instead of accepting a model-authored rationale
  that has no quote-grounding field.
- **Best-effort redaction before truncation.** Emails, bearer/Authorization tokens, common API-key formats, JWTs, `key=value`
  secrets, connection strings and private-key blocks are replaced before anything leaves the server. Unknown secret formats are not
  caught. Only counts are logged.
- **Three gates, then quota.** Server switch (`AI_ENABLED` + usable provider), per-organization opt-in (default off, owner/admin only,
  audited), responder role. The opt-in is re-checked in the worker immediately before the provider call.
- **Atomic daily quota.** One upsert (`ON CONFLICT ... DO UPDATE ... WHERE requests_used < limit`) in the same transaction as the
  suggestion row, the job and the audit entry, so a rejected or rolled-back request is never charged. Retries do not charge again.
  A failure where the provider was never reached (for example the opt-in was withdrawn) refunds once, guarded by the status transition.
- **One in flight per incident** via a partial unique index; a double click is a 409 that costs nothing.
- **Draft only.** "Apply" marks the suggestion applied and returns a draft (a severity to pre-select, or a comment text) for the normal
  edit/comment form. The server never changes an incident or posts a comment on the model's behalf. Repeating the same target is
  idempotent; switching draft target updates `applied_target` and creates an audit event so the recorded target cannot drift.
- **Suggestion history.** The incident UI displays the returned recent suggestion list rather than only the newest row, so generating
  another suggestion does not make an older pending suggestion inaccessible.
- **Append-only audit.** `ai_audit_events` records settings changes, requests, applies and dismissals (ids and enums only).
- **Reuse.** The existing PostgreSQL job queue (new job type `generate_ai_suggestion`, 2 attempts) and the M8 retrieval query.
- **Fake provider.** `AI_PROVIDER=fake` is deterministic, keyless, non-production only. The OpenAI Responses adapter (`store:false`,
  strict `json_schema`) exists but has never been run against the live API.

## Consequences and limits
- The per-user rate limiter is per process (a single API instance is assumed); the daily quota is database-backed and exact.
- The quota day is UTC.
- Prompt-injection resistance rests on fixed instructions, data-only incident text in a JSON message, schema validation and the
  human review step; it is not a guarantee against a model that is persuaded to produce a plausible but wrong grounded answer.
- Migration `0012_grounded_ai_suggestions.sql` is new; migrations 0001-0011 are unchanged.
