import { z } from "zod";
import type { IncidentSeverity } from "./incident";

// ---------------------------------------------------------------------------------------------
// Grounded AI suggestions (Milestone 9). Everything here is advisory: a suggestion is generated from the incident and
// from similar incidents of the SAME organization, validated by the server, and only ever turned into a DRAFT that a
// human reviews and saves through the existing forms. There is deliberately NO organization id in any request schema.

/**
 * queued/running  generation is in flight (at most one per incident)
 * pending         generated and validated, waiting for a human
 * applied         a human turned it into a draft (the draft itself is saved through the normal forms)
 * dismissed       a human rejected it
 * failed          generation did not produce a valid result
 */
export const AI_SUGGESTION_STATUSES = ["queued", "running", "pending", "applied", "dismissed", "failed"] as const;
export type AiSuggestionStatus = (typeof AI_SUGGESTION_STATUSES)[number];

/** Safe, user-facing failure categories. Raw provider errors and model text are never exposed. */
export const AI_SUGGESTION_ERROR_CODES = ["provider_error", "invalid_output", "timeout", "incident_missing", "gate_closed"] as const;
export type AiSuggestionErrorCode = (typeof AI_SUGGESTION_ERROR_CODES)[number];

/** What "Apply" can pre-fill. Both go through existing, human-submitted forms. */
export const AI_APPLY_TARGETS = ["severity", "comment"] as const;
export type AiApplyTarget = (typeof AI_APPLY_TARGETS)[number];

/** Why generating is unavailable right now (shown to every member; deliberately coarse, no configuration details). */
export const AI_UNAVAILABLE_REASONS = ["server_disabled", "org_not_opted_in", "quota_exhausted"] as const;
export type AiUnavailableReason = (typeof AI_UNAVAILABLE_REASONS)[number];

/** Bounds shared by the output validator, the database CHECK constraints and the UI. */
export const AI_LIMITS = {
  summaryChars: 1500,
  rationaleChars: 500,
  stepChars: 400,
  quoteMinChars: 12,
  quoteMaxChars: 300,
  maxCitationsPerClaim: 3,
  maxSteps: 6,
  maxRelatedIncidents: 5,
  /** Serialized size of the raw model output that is still examined; anything larger is rejected unread. */
  maxOutputChars: 12_000,
  commentDraftChars: 5000,
} as const;

export const applyAiSuggestionSchema = z.object({ target: z.enum(AI_APPLY_TARGETS) }).strict();
export const updateAiSettingsSchema = z.object({ suggestionsEnabled: z.boolean() }).strict();

export interface AiCitationDto {
  /** The cited incident (the current one or a similar one). Same organization, enforced by the server. */
  incidentId: string;
  /** Text copied from the cited source (matched ignoring case and whitespace). Provenance only, not proof the claim is true. */
  quote: string;
}

export interface AiSuggestionContentDto {
  summary: { text: string; citations: AiCitationDto[] };
  severity: { value: IncidentSeverity; rationale: string; citations: AiCitationDto[] } | null;
  nextSteps: Array<{ text: string; citations: AiCitationDto[] }>;
  relatedIncidents: Array<{ incidentId: string; reason: string }>;
}

export interface AiSourceIncidentDto {
  number: number;
  title: string;
}

export interface AiSuggestionDto {
  id: string;
  incidentId: string;
  status: AiSuggestionStatus;
  /** The incident version the suggestion was requested for; compare with the current version to show staleness. */
  incidentVersion: number;
  content: AiSuggestionContentDto | null;
  model: string | null;
  promptVersion: string | null;
  errorCode: AiSuggestionErrorCode | null;
  appliedTarget: AiApplyTarget | null;
  createdAt: string;
  completedAt: string | null;
  /** Number and title of every cited/related incident that still exists (null = no longer available). */
  sources: Record<string, AiSourceIncidentDto | null>;
}

export interface AiSettingsDto {
  /** The server-wide switch (AI_ENABLED plus a usable provider). When false nothing below can enable AI. */
  serverEnabled: boolean;
  organizationOptIn: boolean;
  dailyLimit: number;
  usedToday: number;
  remainingToday: number;
  canGenerate: boolean;
  unavailableReason: AiUnavailableReason | null;
}

export interface AiSuggestionStateDto {
  settings: AiSettingsDto;
  items: AiSuggestionDto[];
}

/** The answer to "apply": a DRAFT. Nothing about the incident has been changed. */
export interface AiDraftDto {
  target: AiApplyTarget;
  /** Set when target is "severity": pre-select this in the edit form. */
  severity: IncidentSeverity | null;
  /** Set when target is "comment": pre-fill the comment box with this text. */
  commentBody: string | null;
  suggestion: AiSuggestionDto;
}
