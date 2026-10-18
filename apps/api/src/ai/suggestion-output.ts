import {
  AI_LIMITS,
  incidentSeveritySchema,
  type AiCitationDto,
  type AiSuggestionContentDto,
} from "@platform/shared";
import { z } from "zod";
import type { SuggestionContext } from "./suggestion-context";

/**
 * Validation of what a model returned. The model is UNTRUSTED: nothing it says reaches storage or the UI unless it
 *   1. is a JSON object of bounded size,
 *   2. matches the strict schema below (no extra keys, bounded text, fixed enums, only the four suggestion kinds),
 *   3. cites only sources that were actually sent for THIS request (by alias, so unknown or foreign ids cannot pass), and
 *   4. quotes each source verbatim (ignoring case and whitespace).
 *
 * What this proves: PROVENANCE. A quote that exists in a source shows the model pointed at real text from the same
 * organization. It does NOT prove the claim is true, relevant or safe to act on; that is why a human reviews everything.
 */

// eslint-disable-next-line no-control-regex -- the point of the pattern is to reject control characters (tab and newline stay allowed)
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !CONTROL_CHARS.test(value), "contains control characters");

const alias = z.string().regex(/^S\d{1,2}$/);
const quote = z.string().trim().min(AI_LIMITS.quoteMinChars).max(AI_LIMITS.quoteMaxChars);
const citation = z.object({ source: alias, quote }).strict();
const citations = z.array(citation).min(1).max(AI_LIMITS.maxCitationsPerClaim);

export const suggestionOutputSchema = z
  .object({
    summary: z.object({ text: text(AI_LIMITS.summaryChars), citations }).strict(),
    severity: z
      .union([z.null(), z.object({ value: incidentSeveritySchema, rationale: text(AI_LIMITS.rationaleChars), citations }).strict()]),
    nextSteps: z.array(z.object({ text: text(AI_LIMITS.stepChars), citations }).strict()).max(AI_LIMITS.maxSteps),
    relatedIncidents: z.array(z.object({ source: alias }).strict()).max(AI_LIMITS.maxRelatedIncidents),
  })
  .strict();

type RawOutput = z.infer<typeof suggestionOutputSchema>;

/** Safe failure categories: they name WHAT was wrong and WHERE (a path), never what the model wrote. */
export type SuggestionValidationReason =
  | "not_an_object"
  | "oversized"
  | "schema"
  | "unknown_source"
  | "quote_not_found"
  | "quote_too_weak"
  | "related_not_similar"
  | "related_duplicate";

export type SuggestionValidation =
  | { ok: true; content: AiSuggestionContentDto }
  | { ok: false; reason: SuggestionValidationReason; path: string };

/** Case-, whitespace- and Unicode-form-insensitive comparison form. */
export function normalizeForQuote(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

const PLACEHOLDER = /\[redacted[a-z_]*\]/g;
/** Section labels the server adds to every source ("Incident title:", ...). Quoting only a label proves nothing. */
const LABELS = /\b(?:incident title|description|root cause|fix applied)\s*:/g;
/** Minimum characters of real source content (letters and digits) a quote must carry. */
const MIN_MEANINGFUL_CHARS = 6;

type Failure = Extract<SuggestionValidation, { ok: false }>;

function checkCitation(c: { source: string; quote: string }, context: SuggestionContext, path: string): AiCitationDto | Failure {
  const source = context.sources.find((s) => s.alias === c.source);
  if (!source) return { ok: false, reason: "unknown_source", path };
  const needle = normalizeForQuote(c.quote);
  // A quote made only of redaction placeholders, section labels and punctuation proves nothing.
  if (needle.replace(PLACEHOLDER, "").replace(LABELS, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim().length < MIN_MEANINGFUL_CHARS) {
    return { ok: false, reason: "quote_too_weak", path };
  }
  if (!normalizeForQuote(source.text).includes(needle)) return { ok: false, reason: "quote_not_found", path };
  return { incidentId: source.incidentId, quote: c.quote.replace(/\s+/g, " ").trim() };
}

function isFailure(value: AiCitationDto | Failure): value is Failure {
  return "ok" in value;
}

function checkAll(
  list: ReadonlyArray<{ source: string; quote: string }>,
  context: SuggestionContext,
  path: string,
): { ok: true; citations: AiCitationDto[] } | Failure {
  const out: AiCitationDto[] = [];
  for (const [i, c] of list.entries()) {
    const checked = checkCitation(c, context, `${path}.${i}`);
    if (isFailure(checked)) return checked;
    out.push(checked);
  }
  return { ok: true, citations: out };
}

export function validateSuggestionOutput(raw: unknown, context: SuggestionContext): SuggestionValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "not_an_object", path: "" };
  let size: number;
  try {
    size = JSON.stringify(raw).length;
  } catch {
    return { ok: false, reason: "not_an_object", path: "" };
  }
  if (size > AI_LIMITS.maxOutputChars) return { ok: false, reason: "oversized", path: "" };

  const parsed = suggestionOutputSchema.safeParse(raw);
  if (!parsed.success) {
    // Zod issue PATHS only: the issue message can echo the offending value.
    return { ok: false, reason: "schema", path: parsed.error.issues[0]?.path.join(".") ?? "" };
  }
  const out: RawOutput = parsed.data;

  const summary = checkAll(out.summary.citations, context, "summary.citations");
  if (!summary.ok) return summary;

  let severity: AiSuggestionContentDto["severity"] = null;
  if (out.severity) {
    const checked = checkAll(out.severity.citations, context, "severity.citations");
    if (!checked.ok) return checked;
    severity = { value: out.severity.value, rationale: out.severity.rationale, citations: checked.citations };
  }

  const nextSteps: AiSuggestionContentDto["nextSteps"] = [];
  for (const [i, step] of out.nextSteps.entries()) {
    const checked = checkAll(step.citations, context, `nextSteps.${i}.citations`);
    if (!checked.ok) return checked;
    nextSteps.push({ text: step.text, citations: checked.citations });
  }

  const relatedIncidents: AiSuggestionContentDto["relatedIncidents"] = [];
  const seen = new Set<string>();
  for (const [i, related] of out.relatedIncidents.entries()) {
    const source = context.sources.find((s) => s.alias === related.source);
    if (!source) return { ok: false, reason: "unknown_source", path: `relatedIncidents.${i}.source` };
    if (source.role !== "similar") return { ok: false, reason: "related_not_similar", path: `relatedIncidents.${i}.source` };
    if (seen.has(source.incidentId)) return { ok: false, reason: "related_duplicate", path: `relatedIncidents.${i}.source` };
    seen.add(source.incidentId);
    relatedIncidents.push({ incidentId: source.incidentId, reason: "Retrieved by M8 similar-incident search." });
  }

  return { ok: true, content: { summary: { text: out.summary.text, citations: summary.citations }, severity, nextSteps, relatedIncidents } };
}

/**
 * The comment draft for "Apply -> comment". Composed by the SERVER from already validated text, so the client never
 * builds it and cannot make it say something else. It is only a draft: a human edits it and posts it through the
 * normal comment form.
 */
export function composeCommentDraft(content: AiSuggestionContentDto): string {
  const lines = ["AI-suggested next steps (draft, please review before posting):"];
  if (content.nextSteps.length === 0) lines.push("(The AI did not propose any grounded next steps.)");
  content.nextSteps.forEach((step, i) => lines.push(`${i + 1}. ${step.text}`));
  return lines.join("\n").slice(0, AI_LIMITS.commentDraftChars);
}
