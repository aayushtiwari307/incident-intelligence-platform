import type { AnalysisDto, AnalysisErrorCode, AnalysisStateDto, AnalysisStatus, IncidentSeverity } from "@platform/shared";
import { uuidSchema } from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import { authorize } from "../common/authz";
import { AppError, PG, conflict, notFound, pgCode } from "../common/errors";
import type { Database, SqlClient } from "../common/sql";
import { iso, num } from "../common/sql-helpers";
import type { JobQueue } from "../jobs/job-queue";
import { ANALYZE_INCIDENT_JOB } from "./analysis.handler";

interface Row {
  id: string;
  status: AnalysisStatus;
  incident_version: string | number;
  suggested_severity: IncidentSeverity | null;
  category: string | null;
  summary: string | null;
  probable_cause: string | null;
  steps: unknown;
  model: string | null;
  error_code: AnalysisErrorCode | null;
  created_at: string;
  completed_at: string | null;
}

const toDto = (r: Row): AnalysisDto => ({
  id: r.id,
  status: r.status,
  incidentVersion: num(r.incident_version),
  suggestedSeverity: r.suggested_severity,
  category: r.category,
  summary: r.summary,
  probableCause: r.probable_cause,
  steps: r.steps === null || r.steps === undefined ? null : (typeof r.steps === "string" ? (JSON.parse(r.steps) as string[]) : (r.steps as string[])),
  model: r.model,
  errorCode: r.error_code,
  createdAt: r.created_at,
  completedAt: r.completed_at,
});


export class AnalysisService {
  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    /** False when no AI provider is configured. Then nothing is ever queued and the UI hides the feature. */
    readonly enabled: boolean,
  ) {}

  /**
   * Called by IncidentService INSIDE the incident-creating transaction, so an incident and its analysis job are
   * committed together or not at all.
   */
  async enqueueInTransaction(tx: SqlClient, organizationId: string, incidentId: string, incidentVersion: number, requestedBy: string | null): Promise<void> {
    if (!this.enabled) return;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO incident_analyses (organization_id, incident_id, incident_version, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [organizationId, incidentId, incidentVersion, requestedBy],
    );
    const analysisId = (inserted.rows[0] as { id: string }).id;
    const jobId = await this.queue.enqueue(tx, { organizationId, type: ANALYZE_INCIDENT_JOB, payload: { analysisId } });
    await tx.query("UPDATE incident_analyses SET job_id = $3 WHERE organization_id = $1 AND id = $2", [organizationId, analysisId, jobId]);
  }

  async state(auth: AuthContext, incidentId: string): Promise<AnalysisStateDto> {
    const organizationId = authorize(auth, "incident:read");
    await this.assertIncident(this.db, organizationId, incidentId);
    const rows = await this.db.query<Row>(
      `SELECT id, status, incident_version, suggested_severity, category, summary, probable_cause, steps, model, error_code,
              ${iso("created_at")} AS created_at, ${iso("completed_at")} AS completed_at
         FROM incident_analyses WHERE organization_id = $1 AND incident_id = $2
        ORDER BY created_at DESC, id DESC LIMIT 1`,
      [organizationId, incidentId],
    );
    const row = rows.rows[0];
    return { enabled: this.enabled, analysis: row ? toDto(row) : null };
  }

  /** Requests a (re-)analysis. At most one may be in flight per incident, enforced by a partial unique index. */
  async request(auth: AuthContext, incidentId: string): Promise<AnalysisStateDto> {
    const organizationId = authorize(auth, "analysis:request");
    if (!this.enabled) throw new AppError("FEATURE_DISABLED", "AI analysis is not enabled on this server");
    try {
      await this.db.tx(async (tx) => {
        const incident = await this.assertIncident(tx, organizationId, incidentId, "FOR SHARE");
        await this.enqueueInTransaction(tx, organizationId, incidentId, incident.version, auth.userId);
      });
    } catch (error) {
      if (pgCode(error) === PG.uniqueViolation) throw conflict("An analysis is already in progress for this incident");
      throw error;
    }
    return this.state(auth, incidentId);
  }

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
}
