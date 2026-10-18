import { z } from "zod";
import { emailSchema, uuidSchema } from "./auth";
import { orgRoleSchema } from "./roles";

// ---------------------------------------------------------------------------------------------
// Lifecycle. The same transition graph is enforced by a trigger in migration 0004; a test compares
// the two so they cannot drift apart.

export const INCIDENT_SEVERITIES = ["sev1", "sev2", "sev3", "sev4"] as const;
export type IncidentSeverity = (typeof INCIDENT_SEVERITIES)[number];

export const INCIDENT_STATUSES = ["triggered", "acknowledged", "investigating", "mitigated", "resolved"] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const INCIDENT_TRANSITIONS: Readonly<Record<IncidentStatus, readonly IncidentStatus[]>> = {
  triggered: ["acknowledged", "investigating", "resolved"],
  acknowledged: ["investigating", "mitigated", "resolved"],
  investigating: ["mitigated", "resolved"],
  mitigated: ["investigating", "resolved"], // investigating again = the mitigation did not hold
  resolved: ["investigating"], // reopen
};

export function canTransition(from: IncidentStatus, to: IncidentStatus): boolean {
  return INCIDENT_TRANSITIONS[from].includes(to);
}

export const INCIDENT_EVENT_TYPES = ["created", "status_changed", "assigned", "severity_changed", "edited", "comment", "resolution_changed"] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Request schemas. All are strict: unknown fields are rejected rather than silently ignored.
// There is deliberately NO organization id in any of them: the organization always comes from the
// authenticated session.

export const incidentSeveritySchema = z.enum(INCIDENT_SEVERITIES);
export const incidentStatusSchema = z.enum(INCIDENT_STATUSES);

const titleSchema = z.string().trim().min(1, "Title is required").max(200);
const descriptionSchema = z.string().max(10_000);
const versionSchema = z.number().int().min(1);

export const createIncidentSchema = z
  .object({
    title: titleSchema,
    description: descriptionSchema.default(""),
    severity: incidentSeveritySchema,
    assigneeId: uuidSchema.nullable().optional(),
  })
  .strict();

/** Partial update guarded by optimistic concurrency: `expectedVersion` must match the stored version. */
export const updateIncidentSchema = z
  .object({
    expectedVersion: versionSchema,
    title: titleSchema.optional(),
    description: descriptionSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    assigneeId: uuidSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expectedVersion" && v[k as keyof typeof v] !== undefined), {
    message: "Provide at least one field to change",
  });

export const transitionIncidentSchema = z
  .object({
    to: incidentStatusSchema,
    expectedVersion: versionSchema,
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

export const commentSchema = z.object({ body: z.string().trim().min(1, "Comment is empty").max(5000) }).strict();

const resolutionTextSchema = z.string().trim().min(1).max(2000);
const resolutionVersionSchema = z.number().int().min(1).max(2_147_483_646);

export const createResolutionSchema = z
  .object({
    rootCause: resolutionTextSchema,
    fixApplied: resolutionTextSchema,
  })
  .strict();

export const updateResolutionSchema = z
  .object({
    expectedVersion: resolutionVersionSchema,
    rootCause: resolutionTextSchema,
    fixApplied: resolutionTextSchema,
  })
  .strict();

export const incidentListQuerySchema = z
  .object({
    status: incidentStatusSchema.optional(),
    severity: incidentSeveritySchema.optional(),
    /** "me", "unassigned", or a user id (which must be a member of the organization to match anything). */
    assignee: z.union([z.literal("me"), z.literal("unassigned"), uuidSchema]).optional(),
    cursor: z.string().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();

export const timelineQuerySchema = z
  .object({
    after: z.coerce.number().int().min(0).default(0),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

// ---------------------------------------------------------------------------------------------
// Organization / membership requests

export const createInviteSchema = z
  .object({ email: emailSchema, role: z.enum(["viewer", "responder", "admin"]) })
  .strict();
export const acceptInviteSchema = z.object({ token: z.string().min(20).max(200) }).strict();
export const changeMemberRoleSchema = z.object({ role: orgRoleSchema }).strict();
export const switchOrganizationSchema = z.object({ organizationId: uuidSchema }).strict();

// ---------------------------------------------------------------------------------------------
// Response shapes (what the API returns and the UI consumes)

export interface IncidentDto {
  id: string;
  number: number;
  title: string;
  description: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  assignee: { id: string; displayName: string } | null;
  createdBy: { id: string; displayName: string } | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  acknowledgedAt: string | null;
  mitigatedAt: string | null;
  resolvedAt: string | null;
}

export interface IncidentEventDto {
  id: number;
  type: IncidentEventType;
  actor: { id: string | null; label: string };
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface IncidentResolutionDto {
  incidentId: string;
  rootCause: string;
  fixApplied: string;
  resolvedBy: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SimilarIncidentDto {
  id: string;
  number: number;
  title: string;
  severity: IncidentSeverity;
  resolvedAt: string | null;
  rootCause: string | null;
  fixApplied: string | null;
  matchedTerms: string[];
}

export interface SimilarIncidentsDto {
  results: SimilarIncidentDto[];
}

export interface IncidentListDto {
  items: IncidentDto[];
  nextCursor: string | null;
}

export interface MembershipDto {
  organizationId: string;
  organizationName: string;
  role: z.infer<typeof orgRoleSchema>;
}

export interface MeDto {
  user: { id: string; email: string; displayName: string };
  memberships: MembershipDto[];
  activeOrganizationId: string | null;
  role: z.infer<typeof orgRoleSchema> | null;
}

export interface MemberDto {
  userId: string;
  email: string;
  displayName: string;
  role: z.infer<typeof orgRoleSchema>;
  joinedAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

// ---------------------------------------------------------------------------------------------
// AI-assisted analysis (optional feature: everything else works with AI turned off)

export const ANALYSIS_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/** Safe, user-facing failure categories. Raw provider errors are never exposed. */
export const ANALYSIS_ERROR_CODES = ["provider_error", "invalid_output", "timeout", "incident_missing"] as const;
export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];

/**
 * The ONLY shape accepted from a model. Everything outside it (extra keys, wrong types, oversized text, unknown
 * severities) is rejected, so a prompt-injected or malformed response cannot reach storage or the UI.
 */
export const analysisResultSchema = z
  .object({
    severity: incidentSeveritySchema,
    category: z.string().trim().min(1).max(80),
    summary: z.string().trim().min(1).max(2000),
    probableCause: z.string().trim().min(1).max(2000),
    steps: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  })
  .strict();
export type AnalysisResult = z.infer<typeof analysisResultSchema>;

export interface AnalysisDto {
  id: string;
  status: AnalysisStatus;
  /** The incident version that was analysed; compare with the incident's current version to show staleness. */
  incidentVersion: number;
  suggestedSeverity: IncidentSeverity | null;
  category: string | null;
  summary: string | null;
  probableCause: string | null;
  steps: string[] | null;
  model: string | null;
  errorCode: AnalysisErrorCode | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AnalysisStateDto {
  /** False when no AI provider is configured: the UI hides the feature, nothing is ever queued. */
  enabled: boolean;
  /** Newest analysis, or null if none was requested yet. */
  analysis: AnalysisDto | null;
}
