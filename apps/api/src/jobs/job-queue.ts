import type { Database, SqlClient } from "../common/sql";
import { jsonObject, num } from "../common/sql-helpers";

export interface JobRow {
  id: string;
  organizationId: string;
  type: string;
  payload: Record<string, unknown>;
  /** Attempts including the one that is running now (1 on the first run). */
  attempts: number;
  maxAttempts: number;
}

export interface EnqueueInput {
  organizationId: string;
  type: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  /** Earliest start; defaults to now. */
  delaySeconds?: number;
}

interface RawJob {
  id: string;
  organization_id: string;
  type: string;
  payload: unknown;
  attempts: string | number;
  max_attempts: string | number;
}

const toJob = (r: RawJob): JobRow => ({
  id: r.id,
  organizationId: r.organization_id,
  type: r.type,
  payload: jsonObject(r.payload),
  attempts: num(r.attempts),
  maxAttempts: num(r.max_attempts),
});

const RETURNING_COLUMNS = ["id", "organization_id", "type", "payload", "attempts", "max_attempts"] as const;
const RETURNING = RETURNING_COLUMNS.join(", ");
const RETURNING_QUALIFIED = RETURNING_COLUMNS.map((column) => `j.${column}`).join(", ");

/**
 * A durable job queue on PostgreSQL.
 *
 *  - enqueue takes the caller's transaction, so the job exists if and only if the business change commits
 *    (transactional outbox).
 *  - claim is one atomic UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED): concurrent workers never get the
 *    same job and never block each other.
 *  - a claim is a LEASE. If the worker dies, the lease expires and another worker takes the job over.
 *  - every completion is FENCED on (job id, worker id, status = running): a worker whose lease was taken over cannot
 *    overwrite the new owner's outcome.
 *
 * Delivery is at-least-once (a lease can expire while a slow worker is still running), so handlers must be idempotent
 * or fenced; the analysis handler is both.
 */
export class JobQueue {
  constructor(private readonly db: Database) {}

  async enqueue(tx: SqlClient, input: EnqueueInput): Promise<string> {
    const result = await tx.query<{ id: string }>(
      `INSERT INTO jobs (organization_id, type, payload, max_attempts, run_at)
       VALUES ($1, $2, $3::jsonb, $4, now() + make_interval(secs => $5::int)) RETURNING id`,
      [input.organizationId, input.type, JSON.stringify(input.payload ?? {}), input.maxAttempts ?? 3, input.delaySeconds ?? 0],
    );
    return (result.rows[0] as { id: string }).id;
  }

  /** Claims the next runnable job (a due pending job first, otherwise one whose lease expired). */
  async claim(workerId: string, leaseSeconds: number): Promise<JobRow | null> {
    const pending = await this.claimWhere("status = 'pending' AND run_at <= now()", "run_at, id", workerId, leaseSeconds);
    if (pending) return pending;
    return this.claimWhere("status = 'running' AND locked_until < now() AND attempts < max_attempts", "locked_until, id", workerId, leaseSeconds);
  }

  private async claimWhere(where: string, order: string, workerId: string, leaseSeconds: number): Promise<JobRow | null> {
    const result = await this.db.query<RawJob>(
      `UPDATE jobs
          SET status = 'running', attempts = attempts + 1, locked_by = $1,
              locked_until = now() + make_interval(secs => $2::int)
        WHERE id = (SELECT id FROM jobs WHERE ${where} ORDER BY ${order} FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING ${RETURNING}`,
      [workerId, leaseSeconds],
    );
    const row = result.rows[0];
    return row ? toJob(row) : null;
  }

  /**
   * Jobs whose lease expired after their last allowed attempt can never run again: mark them dead and hand the job
   * back so the owner of the work can record the failure.
   *
   * At most ONE job is reaped per call, so the caller can finalize it (domain notification) in the same transaction
   * and roll back only that job if the notification fails. `excludeIds` lets the caller skip jobs whose finalization
   * already failed in this pass: otherwise a poisoned job at the head of the line (oldest expiry) would be picked
   * again and again and no exhausted job behind it could ever be finalized.
   * SKIP LOCKED lets concurrent workers reap different jobs without waiting on each other.
   */
  async reapExhausted(tx: SqlClient, excludeIds: readonly string[] = []): Promise<JobRow[]> {
    const result = await tx.query<RawJob>(
      `WITH candidate AS (
         SELECT id FROM jobs
          WHERE status = 'running' AND locked_until < now() AND attempts >= max_attempts
            AND NOT (id = ANY($1::uuid[]))
          ORDER BY locked_until, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE jobs AS j
          SET status = 'dead', completed_at = now(), locked_by = NULL, locked_until = NULL,
              last_error = 'lease expired after the last allowed attempt'
         FROM candidate AS c
        WHERE j.id = c.id
        RETURNING ${RETURNING_QUALIFIED}`,
      [[...excludeIds]],
    );
    return result.rows.map(toJob);
  }

  /** Inside a transaction: proves no other worker has taken the job over (fencing by lock holder) and keeps the row locked until commit. */
  async assertOwned(tx: SqlClient, job: JobRow, workerId: string): Promise<boolean> {
    const result = await tx.query(
      "SELECT 1 FROM jobs WHERE id = $1 AND locked_by = $2 AND status = 'running' FOR UPDATE",
      [job.id, workerId],
    );
    return result.rows.length > 0;
  }

  async markSucceeded(tx: SqlClient, job: JobRow): Promise<void> {
    await tx.query(
      `UPDATE jobs SET status = 'succeeded', completed_at = now(), locked_by = NULL, locked_until = NULL, last_error = NULL WHERE id = $1`,
      [job.id],
    );
  }

  /** Inside a transaction (after assertOwned). Retries with a delay while attempts remain, otherwise dead. Returns true if final. */
  async markFailed(tx: SqlClient, job: JobRow, error: string, retryInSeconds: number | null): Promise<boolean> {
    const final = retryInSeconds === null || job.attempts >= job.maxAttempts;
    if (final) {
      await tx.query(
        `UPDATE jobs SET status = 'dead', completed_at = now(), locked_by = NULL, locked_until = NULL, last_error = $2 WHERE id = $1`,
        [job.id, error.slice(0, 500)],
      );
    } else {
      await tx.query(
        `UPDATE jobs SET status = 'pending', locked_by = NULL, locked_until = NULL, last_error = $2,
                run_at = now() + make_interval(secs => $3::int) WHERE id = $1`,
        [job.id, error.slice(0, 500), retryInSeconds],
      );
    }
    return final;
  }
}
