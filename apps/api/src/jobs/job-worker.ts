import { randomUUID } from "node:crypto";
import type { Database, SqlClient } from "../common/sql";
import { redactSecrets } from "../config/redact";
import type { JobQueue, JobRow } from "./job-queue";

/** Thrown by handlers. `code` is stored and shown (safe); `message` is for logs only and is redacted before storage. */
export class JobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = true,
  ) {
    super(message);
    this.name = "JobError";
  }
}

export interface JobHandler<R = unknown> {
  readonly type: string;
  /** The attempt starts (inside the claim's follow-up, outside any long transaction). */
  onStart?(job: JobRow): Promise<void>;
  /** External work lives here and runs with NO database transaction open. Must finish well inside the lease. */
  execute(job: JobRow): Promise<R>;
  /** Runs inside the same transaction that marks the job succeeded, after ownership is re-verified. */
  commit(tx: SqlClient, job: JobRow, result: R): Promise<void>;
  /** Runs inside the transaction that records a failed attempt. `final` means the job is now dead. */
  onFailure(tx: SqlClient, job: JobRow, error: JobError, final: boolean): Promise<void>;
}

export interface WorkerOptions {
  workerId?: string;
  /** Must be longer than the slowest handler (the provider timeout) because there is no heartbeat. */
  leaseSeconds: number;
  pollIntervalMs: number;
  /** Seconds to wait before attempt N+1 after attempt N failed. */
  backoffSeconds?: (attempt: number) => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export const exponentialBackoff = (baseSeconds: number, capSeconds: number) => (attempt: number) =>
  Math.min(capSeconds, baseSeconds * 2 ** Math.max(0, attempt - 1));

/** Upper bound of exhausted jobs finalized per runOnce(), so one pass stays short; the rest follow on the next pass. */
const MAX_REAPS_PER_RUN = 25;
const REAP_FAILURE_LOG_INTERVAL_MS = 60_000;

export class JobWorker {
  readonly workerId: string;
  private readonly handlers = new Map<string, JobHandler>();
  private running = false;
  private loop: Promise<void> | null = null;
  private wake: (() => void) | null = null;
  private readonly reapFailureLoggedAt = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    handlers: JobHandler[],
    private readonly options: WorkerOptions,
  ) {
    this.workerId = options.workerId ?? `worker-${randomUUID()}`;
    for (const h of handlers) this.handlers.set(h.type, h);
  }

  /** Processes at most one job. Returns false when nothing was runnable; infrastructure failures may throw. */
  async runOnce(): Promise<boolean> {
    await this.reapExhausted();
    const job = await this.queue.claim(this.workerId, this.options.leaseSeconds);
    if (!job) return false;

    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.fail(job, null, new JobError("provider_error", `no handler for job type ${job.type}`, false));
      return true;
    }
    try {
      await handler.onStart?.(job);
      const result = await handler.execute(job);
      const owned = await this.db.tx(async (tx) => {
        if (!(await this.queue.assertOwned(tx, job, this.workerId))) return false;
        await handler.commit(tx, job, result);
        await this.queue.markSucceeded(tx, job);
        return true;
      });
      if (!owned) this.options.log?.("job lease lost; result discarded", { jobId: job.id });
    } catch (error) {
      await this.fail(job, handler, error instanceof JobError ? error : new JobError("provider_error", String(error)));
    }
    return true;
  }

  /**
   * Finalizes jobs whose lease expired after their last attempt. Each job is reaped and its handler notified in ONE
   * transaction, so a crash or handler failure can never leave the job dead while its domain row stays "running".
   * A handler that throws rolls back only that job (it stays recoverable); it is logged, skipped for the rest of this
   * pass, and the next exhausted job is tried. A poisoned job therefore blocks neither healthy exhausted jobs nor
   * the claiming of runnable work.
   */
  private async reapExhausted(): Promise<void> {
    const failedThisPass: string[] = [];
    for (let reaped = 0; reaped < MAX_REAPS_PER_RUN; reaped++) {
      const attempt: { job?: JobRow } = {};
      try {
        await this.db.tx(async (tx) => {
          const [dead] = await this.queue.reapExhausted(tx, failedThisPass);
          if (!dead) return;
          attempt.job = dead;
          const handler = this.handlers.get(dead.type);
          if (handler) await handler.onFailure(tx, dead, new JobError("timeout", "lease expired", false), true);
        });
      } catch (error) {
        this.logReapFailure(attempt.job, error);
        if (!attempt.job) return; // infrastructure failure before a candidate was known: stop, do not spin
        failedThisPass.push(attempt.job.id);
        continue;
      }
      if (!attempt.job) return; // nothing left to reap
    }
  }

  /** At most one log line per poisoned job per minute, so a permanently failing finalizer cannot flood the logs. */
  private logReapFailure(job: JobRow | undefined, error: unknown): void {
    const now = Date.now();
    const key = job?.id ?? "unknown";
    const last = this.reapFailureLoggedAt.get(key);
    if (last !== undefined && now - last < REAP_FAILURE_LOG_INTERVAL_MS) return;
    if (this.reapFailureLoggedAt.size > 200) this.reapFailureLoggedAt.clear();
    this.reapFailureLoggedAt.set(key, now);
    this.options.log?.("exhausted job finalization failed; continuing to claim work", {
      ...(job ? { jobId: job.id, type: job.type } : {}),
      error: redactSecrets(error instanceof Error ? error.message : String(error)),
    });
  }

  private async fail(job: JobRow, handler: JobHandler | null, error: JobError): Promise<void> {
    const backoff = this.options.backoffSeconds ?? exponentialBackoff(5, 300);
    const safeMessage = `${error.code}: ${redactSecrets(error.message)}`;
    this.options.log?.("job attempt failed", { jobId: job.id, type: job.type, attempt: job.attempts, code: error.code });
    await this.db.tx(async (tx) => {
      if (!(await this.queue.assertOwned(tx, job, this.workerId))) return; // someone else owns it now
      const final = await this.queue.markFailed(tx, job, safeMessage, error.retryable ? backoff(job.attempts) : null);
      await handler?.onFailure(tx, job, error, final);
    });
  }

  /** Starts the polling loop. Safe to call once. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        let didWork = false;
        try {
          didWork = await this.runOnce();
        } catch (error) {
          this.options.log?.("worker iteration failed", { error: redactSecrets(error instanceof Error ? error.message : String(error)) });
        }
        if (!didWork && this.running) await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.options.pollIntervalMs);
          this.wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    })();
  }

  /** Stops polling and waits for the job in progress (if any) to finish, so shutdown never abandons a lease needlessly. */
  async stop(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
    this.loop = null;
  }
}
