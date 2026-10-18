import type { IncidentSeverity } from "@platform/shared";
import { addCounts, redactForProvider, zeroCounts, type RedactionCounts } from "./redaction";

/**
 * The text a provider is allowed to see, and the only text a citation may quote.
 *
 * Minimal on purpose: title, description and resolution text of the current incident and of similar incidents of the
 * SAME organization. No names, emails (they are redacted if typed into the text), ids, timestamps or organization data.
 * Sources are labelled with short aliases (S0, S1, ...) instead of database ids, so a model cannot "cite" an id it was
 * never shown, and a cross-tenant id is just an unknown alias.
 */
export const CONTEXT_LIMITS = {
  title: 200,
  description: 4000,
  resolutionField: 1000,
  maxSimilar: 5,
  /** Hard cap on the characters of ALL sources together. Later similar incidents are dropped, never the current one. */
  maxTotalChars: 14_000,
} as const;

export interface SuggestionSource {
  /** "S0" is always the current incident; "S1".. are similar resolved incidents in rank order. */
  alias: string;
  role: "current" | "similar";
  incidentId: string;
  /** Redacted, bounded text. This exact string is sent to the provider and is what quotes are verified against. */
  text: string;
}

export interface SuggestionContext {
  sources: SuggestionSource[];
  /** Not citable free text: the current incident's own metadata. */
  incident: { severity: IncidentSeverity; status: string; version: number };
  /** How many values were redacted, by kind. Counts only: the values themselves are never kept. */
  redactions: RedactionCounts;
  /** True if a field was cut to its limit or a similar incident was dropped to stay inside the total cap. */
  truncated: boolean;
}

export interface IncidentText {
  incidentId: string;
  title: string;
  description?: string | null;
  rootCause?: string | null;
  fixApplied?: string | null;
}

export interface CurrentIncidentText extends IncidentText {
  severity: IncidentSeverity;
  status: string;
  version: number;
}

class Builder {
  redactions = zeroCounts();
  truncated = false;

  field(raw: string | null | undefined, limit: number): string {
    if (!raw) return "";
    // Redact the WHOLE value first and cut afterwards: cutting first could split a secret so that a fragment survives.
    const redacted = redactForProvider(raw);
    this.redactions = addCounts(this.redactions, redacted.counts);
    const trimmed = redacted.text.trim();
    if (trimmed.length <= limit) return trimmed;
    this.truncated = true;
    return trimmed.slice(0, limit);
  }
}

function composeText(parts: { title: string; description: string; rootCause: string; fixApplied: string }): string {
  const lines = [`Incident title: ${parts.title}`];
  if (parts.description) lines.push(`Description: ${parts.description}`);
  if (parts.rootCause) lines.push(`Root cause: ${parts.rootCause}`);
  if (parts.fixApplied) lines.push(`Fix applied: ${parts.fixApplied}`);
  return lines.join("\n");
}

/**
 * Pure assembly (no database): redact, bound, label. The caller is responsible for passing ONLY incidents of the
 * authenticated organization; retrieval (loadSuggestionContext) is organization-scoped and this function adds no data.
 */
export function assembleSuggestionContext(current: CurrentIncidentText, similar: readonly IncidentText[]): SuggestionContext {
  const b = new Builder();
  const sources: SuggestionSource[] = [];
  let total = 0;

  const currentText = composeText({
    title: b.field(current.title, CONTEXT_LIMITS.title),
    description: b.field(current.description, CONTEXT_LIMITS.description),
    rootCause: b.field(current.rootCause, CONTEXT_LIMITS.resolutionField),
    fixApplied: b.field(current.fixApplied, CONTEXT_LIMITS.resolutionField),
  });
  sources.push({ alias: "S0", role: "current", incidentId: current.incidentId, text: currentText });
  total += currentText.length;

  const seen = new Set<string>([current.incidentId]);
  for (const candidate of similar.slice(0, CONTEXT_LIMITS.maxSimilar)) {
    if (seen.has(candidate.incidentId)) continue; // never the current incident twice, never a duplicate
    seen.add(candidate.incidentId);
    const text = composeText({
      title: b.field(candidate.title, CONTEXT_LIMITS.title),
      description: b.field(candidate.description, CONTEXT_LIMITS.description),
      rootCause: b.field(candidate.rootCause, CONTEXT_LIMITS.resolutionField),
      fixApplied: b.field(candidate.fixApplied, CONTEXT_LIMITS.resolutionField),
    });
    if (total + text.length > CONTEXT_LIMITS.maxTotalChars) {
      b.truncated = true;
      break; // keep rank order: do not skip ahead to a shorter, lower-ranked incident
    }
    sources.push({ alias: `S${sources.length}`, role: "similar", incidentId: candidate.incidentId, text });
    total += text.length;
  }

  return {
    sources,
    incident: { severity: current.severity, status: current.status, version: current.version },
    redactions: b.redactions,
    truncated: b.truncated,
  };
}
