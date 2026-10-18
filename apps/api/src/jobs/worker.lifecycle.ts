import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { createLogger } from "../common/logger";
import type { JobWorker } from "./job-worker";

export const JOB_WORKER = Symbol("JOB_WORKER");
const log = createLogger("info");

/**
 * Runs the worker inside the API process (like the reference project's embedded worker; it can move to its own
 * process later because everything goes through the `jobs` table). Stopped BEFORE the database pool closes so an
 * in-flight job can finish its final transaction.
 */
@Injectable()
export class WorkerLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(JOB_WORKER) private readonly worker: JobWorker | null) {}

  onApplicationBootstrap(): void {
    if (!this.worker) {
      log.info("job worker not started (no AI feature is enabled)");
      return;
    }
    this.worker.start();
    log.info("job worker started", { workerId: this.worker.workerId });
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker?.stop();
  }
}
