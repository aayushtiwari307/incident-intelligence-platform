import { analysisResultSchema, type AnalysisErrorCode, type AnalysisResult, type IncidentSeverity } from "@platform/shared";
import type { Database, SqlClient } from "../common/sql";
import { JobError, type JobHandler } from "../jobs/job-worker";
import type { JobRow } from "../jobs/job-queue";
import { ProviderError, type AnalysisProvider } from "./provider";

export const ANALYZE_INCIDENT_JOB = "analyze_incident";

const SAFE_CODES: ReadonlySet<string> = new Set<AnalysisErrorCode>(["provider_error", "invalid_output", "timeout", "incident_missing"]);

/**
 * Analyses one incident. The organization comes from the JOB ROW (written by the server in the requesting
 * transaction), never from the payload, and every read and write is filtered by it.
 */
export class AnalysisJobHandler implements JobHandler<AnalysisResult> {
  readonly type = ANALYZE_INCIDENT_JOB;

  constructor(
    private readonly db: Database,
    private readonly provider: AnalysisProvider,
  ) {}

  private analysisId(job: JobRow): string {
    const id = job.payload.analysisId;
    if (typeof id !== "string") throw new JobError("incident_missing", "job has no analysisId", false);
    return id;
  }

  async onStart(job: JobRow): Promise<void> {
    await this.db.query(
      "UPDATE incident_analyses SET status = 'running' WHERE organization_id = $1 AND id = $2 AND status = 'queued'",
      [job.organizationId, this.analysisId(job)],
    );
  }

  async execute(job: JobRow): Promise<AnalysisResult> {
    const found = await this.db.query<{ title: string; description: string; severity: IncidentSeverity; status: string }>(
      `SELECT i.title, i.description, i.severity, i.status
         FROM incident_analyses a
         JOIN incidents i ON i.organization_id = a.organization_id AND i.id = a.incident_id
        WHERE a.organization_id = $1 AND a.id = $2`,
      [job.organizationId, this.analysisId(job)],
    );
    const incident = found.rows[0];
    if (!incident) throw new JobError("incident_missing", "incident no longer exists", false);

    let raw: unknown;
    try {
      raw = await this.provider.analyze(incident);
    } catch (error) {
      if (error instanceof ProviderError) throw new JobError(error.kind, error.message, error.retryable);
      throw new JobError("provider_error", "unexpected provider failure", true);
    }
    const parsed = analysisResultSchema.safeParse(raw);
    if (!parsed.success) {
      // Zod issue paths only; never the model's text.
      throw new JobError("invalid_output", `output failed validation (${parsed.error.issues.map((i) => i.path.join(".")).join(", ")})`, true);
    }
    return parsed.data;
  }

  async commit(tx: SqlClient, job: JobRow, result: AnalysisResult): Promise<void> {
    await tx.query(
      `UPDATE incident_analyses
          SET status = 'completed', model = $3, suggested_severity = $4, category = $5, summary = $6,
              probable_cause = $7, steps = $8::jsonb, error_code = NULL, completed_at = now()
        WHERE organization_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
      [job.organizationId, this.analysisId(job), this.provider.model, result.severity, result.category, result.summary, result.probableCause, JSON.stringify(result.steps)],
    );
  }

  async onFailure(tx: SqlClient, job: JobRow, error: JobError, final: boolean): Promise<void> {
    const id = typeof job.payload.analysisId === "string" ? job.payload.analysisId : null;
    if (!id) return;
    if (final) {
      const code = SAFE_CODES.has(error.code) ? error.code : "provider_error";
      await tx.query(
        `UPDATE incident_analyses SET status = 'failed', error_code = $3, completed_at = now()
          WHERE organization_id = $1 AND id = $2 AND status IN ('queued', 'running')`,
        [job.organizationId, id, code],
      );
    } else {
      await tx.query("UPDATE incident_analyses SET status = 'queued' WHERE organization_id = $1 AND id = $2 AND status = 'running'", [job.organizationId, id]);
    }
  }
}
