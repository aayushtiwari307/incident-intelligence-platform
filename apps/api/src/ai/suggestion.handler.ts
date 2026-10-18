import type { AiSuggestionContentDto, AiSuggestionErrorCode } from "@platform/shared";
import { ProviderError } from "../analysis/provider";
import type { Database, SqlClient } from "../common/sql";
import type { IncidentService } from "../incidents/incident.service";
import type { JobRow } from "../jobs/job-queue";
import { JobError, type JobHandler } from "../jobs/job-worker";
import { loadSuggestionContext } from "./suggestion-context-loader";
import { totalRedactions } from "./redaction";
import { SUGGESTION_MAX_OUTPUT_TOKENS, SUGGESTION_PROMPT_VERSION, SUGGESTION_SYSTEM_PROMPT, buildSuggestionUserMessage } from "./suggestion-prompt";
import type { SuggestionProvider } from "./suggestion-provider";
import { refundDailyQuota } from "./suggestion-quota";
import { validateSuggestionOutput } from "./suggestion-output";

export const GENERATE_AI_SUGGESTION_JOB = "generate_ai_suggestion";

/** Each logical request may use the provider at most this many times (the quota is charged once, whatever the retries). */
export const SUGGESTION_JOB_MAX_ATTEMPTS = 2;

const SAFE_CODES: ReadonlySet<string> = new Set<AiSuggestionErrorCode>(["provider_error", "invalid_output", "timeout", "incident_missing", "gate_closed"]);

type Outcome =
  | { kind: "skipped" }
  | { kind: "result"; content: AiSuggestionContentDto; model: string; usage: { inputTokens: number | null; outputTokens: number | null } | null };

interface Log {
  (message: string, fields?: Record<string, unknown>): void;
}

/**
 * Generates one suggestion. The organization comes from the JOB ROW (written by the server in the requesting
 * transaction), never from the payload, and every read and write is filtered by it.
 *
 * Gates are re-checked HERE, immediately before the provider could be called, because time passes between "queued" and
 * "running" (an admin may have switched AI off). A closed gate fails the request with `gate_closed` and refunds the
 * quota: the provider was never reached. The provider is only ever called from `execute`, after every gate passed.
 */
export class SuggestionJobHandler implements JobHandler<Outcome> {
  readonly type = GENERATE_AI_SUGGESTION_JOB;

  constructor(
    private readonly db: Database,
    private readonly provider: SuggestionProvider,
    private readonly incidents: Pick<IncidentService, "similarForOrganization">,
    private readonly log?: Log,
  ) {}

  private suggestionId(job: JobRow): string {
    const id = job.payload.suggestionId;
    if (typeof id !== "string") throw new JobError("provider_error", "job has no suggestionId", false);
    return id;
  }

  async onStart(job: JobRow): Promise<void> {
    await this.db.query("UPDATE ai_suggestions SET status = 'running' WHERE organization_id = $1 AND id = $2 AND status = 'queued'", [
      job.organizationId,
      this.suggestionId(job),
    ]);
  }

  async execute(job: JobRow): Promise<Outcome> {
    const suggestionId = this.suggestionId(job);
    const found = await this.db.query<{ status: string; incident_id: string }>(
      "SELECT status, incident_id FROM ai_suggestions WHERE organization_id = $1 AND id = $2",
      [job.organizationId, suggestionId],
    );
    const row = found.rows[0];
    if (!row) throw new JobError("incident_missing", "suggestion no longer exists", false);
    // At-least-once delivery: a duplicate run of an already finished request does nothing (and never calls the provider).
    if (row.status !== "queued" && row.status !== "running") return { kind: "skipped" };

    // Gate: the organization must still be opted in.
    const optIn = await this.db.query<{ suggestions_enabled: boolean }>(
      "SELECT suggestions_enabled FROM organization_ai_settings WHERE organization_id = $1",
      [job.organizationId],
    );
    if (optIn.rows[0]?.suggestions_enabled !== true) throw new JobError("gate_closed", "organization opt-in is off", false);

    const context = await loadSuggestionContext(this.db, this.incidents, job.organizationId, row.incident_id);
    if (!context) throw new JobError("incident_missing", "incident no longer exists", false);

    // From here on the provider is reached: record it BEFORE the call so a crash mid-call still counts as charged.
    await this.db.query(
      `UPDATE ai_suggestions SET provider_attempted_at = COALESCE(provider_attempted_at, now())
        WHERE organization_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
      [job.organizationId, suggestionId],
    );

    let response;
    try {
      response = await this.provider.suggest({
        promptVersion: SUGGESTION_PROMPT_VERSION,
        system: SUGGESTION_SYSTEM_PROMPT,
        user: buildSuggestionUserMessage(context),
        context,
        maxOutputTokens: SUGGESTION_MAX_OUTPUT_TOKENS,
      });
    } catch (error) {
      if (error instanceof ProviderError) throw new JobError(error.kind, error.message, error.retryable);
      throw new JobError("provider_error", "unexpected provider failure", true);
    }

    const checked = validateSuggestionOutput(response.output, context);
    if (!checked.ok) {
      // Reason and PATH only; the model's text is never copied into an error, a log line or the job row.
      this.log?.("ai suggestion output rejected", { jobId: job.id, reason: checked.reason, path: checked.path });
      throw new JobError("invalid_output", `output failed validation (${checked.reason} at ${checked.path || "root"})`, true);
    }
    this.log?.("ai suggestion generated", {
      jobId: job.id,
      sources: context.sources.length,
      redactions: totalRedactions(context.redactions),
      truncated: context.truncated,
    });
    return { kind: "result", content: checked.content, model: this.provider.model, usage: response.usage };
  }

  async commit(tx: SqlClient, job: JobRow, outcome: Outcome): Promise<void> {
    if (outcome.kind === "skipped") return;
    await tx.query(
      `UPDATE ai_suggestions
          SET status = 'pending', content = $3::jsonb, model = $4, prompt_version = $5, input_tokens = $6, output_tokens = $7,
              error_code = NULL, completed_at = now()
        WHERE organization_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
      [
        job.organizationId,
        this.suggestionId(job),
        JSON.stringify(outcome.content),
        outcome.model.slice(0, 100),
        SUGGESTION_PROMPT_VERSION,
        outcome.usage?.inputTokens ?? null,
        outcome.usage?.outputTokens ?? null,
      ],
    );
  }

  async onFailure(tx: SqlClient, job: JobRow, error: JobError, final: boolean): Promise<void> {
    const id = typeof job.payload.suggestionId === "string" ? job.payload.suggestionId : null;
    if (!id) return;
    if (!final) {
      await tx.query("UPDATE ai_suggestions SET status = 'queued' WHERE organization_id = $1 AND id = $2 AND status = 'running'", [job.organizationId, id]);
      return;
    }
    const code = SAFE_CODES.has(error.code) ? error.code : "provider_error";
    // The status guard is what makes the refund happen at most once: only the call that moves the row out of
    // queued/running sees it. A request whose provider was never reached is refunded; one that was reached stays charged.
    const failed = await tx.query<{ quota_date: string; quota_refunded: boolean }>(
      `UPDATE ai_suggestions
          SET status = 'failed', error_code = $3, completed_at = now(), quota_refunded = (provider_attempted_at IS NULL)
        WHERE organization_id = $1 AND id = $2 AND status IN ('queued', 'running')
        RETURNING quota_date::text AS quota_date, quota_refunded`,
      [job.organizationId, id, code],
    );
    const row = failed.rows[0];
    if (row?.quota_refunded) await refundDailyQuota(tx, job.organizationId, row.quota_date);
  }
}
