import {
  applyAiSuggestionSchema,
  updateAiSettingsSchema,
  uuidSchema,
  type AiApplyTarget,
  type AiDraftDto,
  type AiSettingsDto,
  type AiSourceIncidentDto,
  type AiSuggestionContentDto,
  type AiSuggestionDto,
  type AiSuggestionErrorCode,
  type AiSuggestionStateDto,
  type AiSuggestionStatus,
  type AiUnavailableReason,
} from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { authorize } from "../common/authz";
import { AppError, PG, conflict, notFound, pgCode, rateLimited, validationFailed } from "../common/errors";
import type { Database, SqlClient } from "../common/sql";
import { iso, num } from "../common/sql-helpers";
import type { SlidingWindowLimiter } from "../http/rate-limiter";
import type { JobQueue } from "../jobs/job-queue";
import { GENERATE_AI_SUGGESTION_JOB, SUGGESTION_JOB_MAX_ATTEMPTS } from "./suggestion.handler";
import { composeCommentDraft } from "./suggestion-output";
import { reserveDailyQuota, secondsUntilUtcMidnight, usedToday } from "./suggestion-quota";

export interface AiSuggestionServiceOptions {
  /** The server-wide switch: AI_ENABLED is true AND a usable provider exists. When false nothing can be queued. */
  serverEnabled: boolean;
  /** Requests per organization per UTC day. */
  dailyLimit: number;
  /** Per (organization, user) rate limit on generate requests. In process memory, like every limiter in this API. */
  userLimiter: SlidingWindowLimiter;
}

type AuditType = "ai_settings_changed" | "suggestion_requested" | "suggestion_applied" | "suggestion_dismissed";

interface SuggestionRow {
  id: string;
  incident_id: string;
  incident_version: string | number;
  status: AiSuggestionStatus;
  content: unknown;
  model: string | null;
  prompt_version: string | null;
  error_code: AiSuggestionErrorCode | null;
  applied_target: AiApplyTarget | null;
  created_at: string;
  completed_at: string | null;
}

const COLUMNS = `s.id, s.incident_id, s.incident_version, s.status, s.content, s.model, s.prompt_version, s.error_code, s.applied_target,
  ${iso("s.created_at")} AS created_at, ${iso("s.completed_at")} AS completed_at`;

/** How many suggestions the incident page lists (newest first). */
const LIST_LIMIT = 10;

function featureDisabled(reason: AiUnavailableReason, message: string): AppError {
  return new AppError("FEATURE_DISABLED", message, { details: { reason } });
}

const parseContent = (value: unknown): AiSuggestionContentDto | null => {
  if (value === null || value === undefined) return null;
  return (typeof value === "string" ? JSON.parse(value) : value) as AiSuggestionContentDto;
};

function citedIncidentIds(content: AiSuggestionContentDto | null): string[] {
  if (!content) return [];
  const ids = new Set<string>();
  for (const c of content.summary.citations) ids.add(c.incidentId);
  for (const c of content.severity?.citations ?? []) ids.add(c.incidentId);
  for (const step of content.nextSteps) for (const c of step.citations) ids.add(c.incidentId);
  for (const r of content.relatedIncidents) ids.add(r.incidentId);
  return [...ids];
}

/**
 * Grounded AI suggestions: who may ask, what gates apply, how the daily quota is charged, and what "apply" means.
 *
 * Nothing here changes an incident. Generating creates a suggestion row and a queued job; a human can then turn the
 * result into a DRAFT (returned to the browser, which pre-fills the normal edit or comment form) or dismiss it. Every
 * mutation is audited in the same transaction as the change.
 */
export class AiSuggestionService {
  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    private readonly options: AiSuggestionServiceOptions,
  ) {}

  get serverEnabled(): boolean {
    return this.options.serverEnabled;
  }

  // ---- organization settings ---------------------------------------------------------------------------------

  async settings(auth: AuthContext): Promise<AiSettingsDto> {
    const organizationId = authorize(auth, "incident:read");
    return this.loadSettings(this.db, organizationId);
  }

  /** Owner/admin only. Idempotent: setting the current value changes nothing and writes no audit entry. */
  async updateSettings(auth: AuthContext, raw: unknown): Promise<AiSettingsDto> {
    const organizationId = authorize(auth, "ai:configure");
    const parsed = updateAiSettingsSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const desired = parsed.data.suggestionsEnabled;

    await this.db.tx(async (tx) => {
      // Ensure the row exists, then lock it: concurrent toggles and in-flight generate requests (which take FOR SHARE on
      // this row) serialise here, so a request can never be queued by an organization that has just opted out.
      await tx.query("INSERT INTO organization_ai_settings (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING", [organizationId]);
      const current = await tx.query<{ suggestions_enabled: boolean }>(
        "SELECT suggestions_enabled FROM organization_ai_settings WHERE organization_id = $1 FOR UPDATE",
        [organizationId],
      );
      const before = current.rows[0]?.suggestions_enabled === true;
      if (before === desired) return;
      await tx.query("UPDATE organization_ai_settings SET suggestions_enabled = $2, updated_by = $3, updated_at = now() WHERE organization_id = $1", [
        organizationId,
        desired,
        auth.userId,
      ]);
      await this.audit(tx, organizationId, null, null, "ai_settings_changed", auth, { from: before, to: desired });
    });
    return this.loadSettings(this.db, organizationId);
  }

  // ---- per-incident state and actions -------------------------------------------------------------------------

  async state(auth: AuthContext, incidentId: string): Promise<AiSuggestionStateDto> {
    const organizationId = authorize(auth, "incident:read");
    await this.assertIncident(this.db, organizationId, incidentId);
    const rows = await this.db.query<SuggestionRow>(
      `SELECT ${COLUMNS} FROM ai_suggestions s
        WHERE s.organization_id = $1 AND s.incident_id = $2
        ORDER BY s.created_at DESC, s.id DESC LIMIT ${LIST_LIMIT}`,
      [organizationId, incidentId],
    );
    return { settings: await this.loadSettings(this.db, organizationId), items: await this.toDtos(this.db, organizationId, rows.rows) };
  }

  /**
   * Queues ONE generation. Order matters: role, server switch, organization opt-in, per-user rate limit, then ONE
   * transaction that reserves quota, creates the suggestion and its job, and writes the audit entry. Either all of it
   * happens or none of it does, so quota is charged exactly once per logical request and never for a rejected one.
   */
  async request(auth: AuthContext, incidentId: string): Promise<AiSuggestionStateDto> {
    const organizationId = authorize(auth, "aiSuggestion:use");
    if (!this.options.serverEnabled) throw featureDisabled("server_disabled", "AI suggestions are not enabled on this server");

    const limit = this.options.userLimiter.consume(`${organizationId}:${auth.userId}`);
    if (!limit.allowed) throw rateLimited(limit.retryAfterSeconds);

    try {
      await this.db.tx(async (tx) => {
        const incident = await this.assertIncident(tx, organizationId, incidentId, "FOR SHARE");

        const optIn = await tx.query<{ suggestions_enabled: boolean }>(
          "SELECT suggestions_enabled FROM organization_ai_settings WHERE organization_id = $1 FOR SHARE",
          [organizationId],
        );
        if (optIn.rows[0]?.suggestions_enabled !== true) {
          throw featureDisabled("org_not_opted_in", "AI suggestions are not enabled for this organization. An owner or admin can turn them on.");
        }

        const reserved = await reserveDailyQuota(tx, organizationId, this.options.dailyLimit);
        if (!reserved) {
          throw new AppError("RATE_LIMITED", "The daily AI suggestion limit for this organization has been reached (resets at 00:00 UTC).", {
            details: { reason: "quota_exhausted" as AiUnavailableReason },
            headers: { "Retry-After": String(secondsUntilUtcMidnight()) },
          });
        }

        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO ai_suggestions (organization_id, incident_id, incident_version, requested_by, quota_date)
           VALUES ($1, $2, $3, $4, $5::date) RETURNING id`,
          [organizationId, incidentId, incident.version, auth.userId, reserved.usageDate],
        );
        const suggestionId = (inserted.rows[0] as { id: string }).id;
        const jobId = await this.queue.enqueue(tx, {
          organizationId,
          type: GENERATE_AI_SUGGESTION_JOB,
          payload: { suggestionId },
          maxAttempts: SUGGESTION_JOB_MAX_ATTEMPTS,
        });
        await tx.query("UPDATE ai_suggestions SET job_id = $3 WHERE organization_id = $1 AND id = $2", [organizationId, suggestionId, jobId]);
        await this.audit(tx, organizationId, incidentId, suggestionId, "suggestion_requested", auth, {});
      });
    } catch (error) {
      // The unique index allows one queued/running suggestion per incident. The whole transaction (including the quota
      // reservation) has been rolled back, so a double click costs nothing.
      if (pgCode(error) === PG.uniqueViolation) throw conflict("A suggestion is already being generated for this incident");
      throw error;
    }
    return this.state(auth, incidentId);
  }

  /**
   * Turns a pending suggestion into a DRAFT. Nothing about the incident changes: the browser pre-fills the existing edit
   * or comment form and a human still reviews and saves. First apply marks the suggestion applied (audited); repeating the
   * same target is idempotent, while choosing another target updates the recorded target and adds an audit entry.
   */
  async apply(auth: AuthContext, incidentId: string, suggestionId: string, raw: unknown): Promise<AiDraftDto> {
    const organizationId = authorize(auth, "aiSuggestion:use");
    const parsed = applyAiSuggestionSchema.safeParse(raw);
    if (!parsed.success) throw validationFailed(parsed.error);
    const target = parsed.data.target;

    const row = await this.db.tx(async (tx) => {
      const current = await this.lockSuggestion(tx, organizationId, incidentId, suggestionId);
      if (current.status !== "pending" && current.status !== "applied") {
        throw conflict(current.status === "dismissed" ? "This suggestion was dismissed" : "This suggestion is not ready yet");
      }
      const content = parseContent(current.content) as AiSuggestionContentDto;
      if (target === "severity" && !content.severity) {
        throw new AppError("VALIDATION_FAILED", "This suggestion does not propose a severity", { details: [{ path: "target", message: "No severity proposed" }] });
      }
      if (current.status === "pending") {
        await tx.query(
          `UPDATE ai_suggestions SET status = 'applied', applied_target = $3, reviewed_by = $4, reviewed_at = now()
            WHERE organization_id = $1 AND id = $2 AND status = 'pending'`,
          [organizationId, suggestionId, target, auth.userId],
        );
        await this.audit(tx, organizationId, incidentId, suggestionId, "suggestion_applied", auth, { target });
      } else if (current.applied_target !== target) {
        // Selecting a different draft target is a meaningful human action: keep the recorded target in sync and audit
        // the change. Repeating the SAME target is idempotent and does not spam the audit trail.
        await tx.query(
          `UPDATE ai_suggestions SET applied_target = $3, reviewed_by = $4, reviewed_at = now()
            WHERE organization_id = $1 AND id = $2 AND status = 'applied'`,
          [organizationId, suggestionId, target, auth.userId],
        );
        await this.audit(tx, organizationId, incidentId, suggestionId, "suggestion_applied", auth, { from: current.applied_target, target });
      }
      return this.loadOne(tx, organizationId, suggestionId);
    });

    const [suggestion] = await this.toDtos(this.db, organizationId, [row]);
    const content = (suggestion as AiSuggestionDto).content as AiSuggestionContentDto;
    return {
      target,
      severity: target === "severity" ? (content.severity?.value ?? null) : null,
      commentBody: target === "comment" ? composeCommentDraft(content) : null,
      suggestion: suggestion as AiSuggestionDto,
    };
  }

  async dismiss(auth: AuthContext, incidentId: string, suggestionId: string): Promise<AiSuggestionDto> {
    const organizationId = authorize(auth, "aiSuggestion:use");
    const row = await this.db.tx(async (tx) => {
      const current = await this.lockSuggestion(tx, organizationId, incidentId, suggestionId);
      if (current.status !== "pending") throw conflict("Only a suggestion that is waiting for review can be dismissed");
      await tx.query(
        `UPDATE ai_suggestions SET status = 'dismissed', reviewed_by = $3, reviewed_at = now()
          WHERE organization_id = $1 AND id = $2 AND status = 'pending'`,
        [organizationId, suggestionId, auth.userId],
      );
      await this.audit(tx, organizationId, incidentId, suggestionId, "suggestion_dismissed", auth, {});
      return this.loadOne(tx, organizationId, suggestionId);
    });
    return (await this.toDtos(this.db, organizationId, [row]))[0] as AiSuggestionDto;
  }

  // ---------------------------------------------------------------------------------------------

  private async loadSettings(db: SqlClient, organizationId: string): Promise<AiSettingsDto> {
    const [optIn, used] = await Promise.all([
      db.query<{ suggestions_enabled: boolean }>("SELECT suggestions_enabled FROM organization_ai_settings WHERE organization_id = $1", [organizationId]),
      usedToday(db, organizationId),
    ]);
    const organizationOptIn = optIn.rows[0]?.suggestions_enabled === true;
    const dailyLimit = this.options.dailyLimit;
    const remainingToday = Math.max(0, dailyLimit - used);
    let unavailableReason: AiUnavailableReason | null = null;
    if (!this.options.serverEnabled) unavailableReason = "server_disabled";
    else if (!organizationOptIn) unavailableReason = "org_not_opted_in";
    else if (remainingToday === 0) unavailableReason = "quota_exhausted";
    return {
      serverEnabled: this.options.serverEnabled,
      organizationOptIn,
      dailyLimit,
      usedToday: used,
      remainingToday,
      canGenerate: unavailableReason === null,
      unavailableReason,
    };
  }

  /** 404 for another organization's incident, exactly like a missing one. */
  private async assertIncident(db: SqlClient, organizationId: string, incidentId: string, lock = ""): Promise<{ version: number }> {
    if (!uuidSchema.safeParse(incidentId).success) throw notFound("Incident");
    const found = await db.query<{ version: string | number }>(
      `SELECT version FROM incidents WHERE organization_id = $1 AND id = $2 ${lock}`,
      [organizationId, incidentId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Incident");
    return { version: num(row.version) };
  }

  private async lockSuggestion(tx: SqlClient, organizationId: string, incidentId: string, suggestionId: string): Promise<SuggestionRow> {
    if (!uuidSchema.safeParse(incidentId).success || !uuidSchema.safeParse(suggestionId).success) throw notFound("Suggestion");
    const found = await tx.query<SuggestionRow>(
      `SELECT ${COLUMNS} FROM ai_suggestions s
        WHERE s.organization_id = $1 AND s.incident_id = $2 AND s.id = $3 FOR UPDATE`,
      [organizationId, incidentId, suggestionId],
    );
    const row = found.rows[0];
    if (!row) throw notFound("Suggestion");
    return row;
  }

  private async loadOne(tx: SqlClient, organizationId: string, suggestionId: string): Promise<SuggestionRow> {
    const found = await tx.query<SuggestionRow>(`SELECT ${COLUMNS} FROM ai_suggestions s WHERE s.organization_id = $1 AND s.id = $2`, [organizationId, suggestionId]);
    return found.rows[0] as SuggestionRow;
  }

  /** Maps rows to DTOs and resolves every cited incident (same organization only) to its number and title in ONE query. */
  private async toDtos(db: SqlClient, organizationId: string, rows: SuggestionRow[]): Promise<AiSuggestionDto[]> {
    const contents = rows.map((r) => parseContent(r.content));
    const ids = [...new Set(contents.flatMap(citedIncidentIds))];
    const known = new Map<string, AiSourceIncidentDto>();
    if (ids.length > 0) {
      const found = await db.query<{ id: string; number: string | number; title: string }>(
        "SELECT id, number, title FROM incidents WHERE organization_id = $1 AND id = ANY($2::uuid[])",
        [organizationId, ids],
      );
      for (const r of found.rows) known.set(r.id, { number: num(r.number), title: r.title });
    }
    return rows.map((r, i) => {
      const content = contents[i] ?? null;
      const sources: Record<string, AiSourceIncidentDto | null> = {};
      for (const id of citedIncidentIds(content)) sources[id] = known.get(id) ?? null;
      return {
        id: r.id,
        incidentId: r.incident_id,
        status: r.status,
        incidentVersion: num(r.incident_version),
        content,
        model: r.model,
        promptVersion: r.prompt_version,
        errorCode: r.error_code,
        appliedTarget: r.applied_target,
        createdAt: r.created_at,
        completedAt: r.completed_at,
        sources,
      };
    });
  }

  /** Append-only audit entry. Same transaction as the change it records; identifiers and enums only, never model text. */
  private async audit(
    tx: SqlClient,
    organizationId: string,
    incidentId: string | null,
    suggestionId: string | null,
    type: AuditType,
    actor: { userId: string; displayName: string },
    payload: Record<string, unknown>,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO ai_audit_events (organization_id, incident_id, suggestion_id, type, actor_id, actor_label, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [organizationId, incidentId, suggestionId, type, actor.userId, actor.displayName.slice(0, 80), JSON.stringify(payload)],
    );
  }
}
