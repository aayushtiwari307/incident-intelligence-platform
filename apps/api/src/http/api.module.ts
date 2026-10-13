import { Module } from "@nestjs/common";
import { AnalysisJobHandler } from "../analysis/analysis.handler";
import { AnalysisService } from "../analysis/analysis.service";
import { createAnalysisProvider } from "../analysis/provider-factory";
import type { AnalysisProvider } from "../analysis/provider";
import { AuthService } from "../auth/auth.service";
import { PasswordHasher } from "../auth/password";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/env";
import { DatabaseService } from "../db/database.service";
import { IncidentService } from "../incidents/incident.service";
import { JobQueue } from "../jobs/job-queue";
import { JobWorker, exponentialBackoff } from "../jobs/job-worker";
import { JOB_WORKER, WorkerLifecycle } from "../jobs/worker.lifecycle";
import { createLogger } from "../common/logger";
import { OrganizationService } from "../organizations/organization.service";
import { ApiHandlers } from "./api-handlers";
import { AuthController, IncidentController, OrganizationController } from "./api.controllers";
import { SlidingWindowLimiter } from "./rate-limiter";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

/** Transport injection is private to the process; production defaults to global fetch and the fixed OpenAI URL. */
export const OPENAI_FETCH = Symbol("OPENAI_FETCH");
const ANALYSIS_PROVIDER = Symbol("ANALYSIS_PROVIDER");

/**
 * Wires the framework-free services to Nest. Rate limiters are in process memory: correct for a single API
 * instance, per-instance (so effectively looser) when scaled out. Moving them to Redis is the planned fix (ADR 0010).
 */
@Module({
  controllers: [AuthController, OrganizationController, IncidentController],
  providers: [
    { provide: OPENAI_FETCH, useValue: fetch },
    {
      provide: ANALYSIS_PROVIDER,
      inject: [APP_CONFIG, OPENAI_FETCH],
      useFactory: (config: AppConfig, fetchImpl: typeof fetch): AnalysisProvider | null =>
        createAnalysisProvider(config.ai, { fetchImpl }),
    },
    {
      provide: AuthService,
      inject: [DatabaseService, APP_CONFIG],
      useFactory: (db: DatabaseService, config: AppConfig) =>
        new AuthService(db.database, new PasswordHasher(), {
          sessionTtlSeconds: config.auth.sessionTtlSeconds,
          loginIpLimiter: new SlidingWindowLimiter(100, FIFTEEN_MINUTES),
          loginAccountLimiter: new SlidingWindowLimiter(5, FIFTEEN_MINUTES),
          registerIpLimiter: new SlidingWindowLimiter(10, ONE_HOUR),
        }),
    },
    {
      provide: OrganizationService,
      inject: [DatabaseService, APP_CONFIG],
      useFactory: (db: DatabaseService, config: AppConfig) => new OrganizationService(db.database, config.auth.inviteTtlSeconds),
    },
    { provide: JobQueue, inject: [DatabaseService], useFactory: (db: DatabaseService) => new JobQueue(db.database) },
    {
      provide: AnalysisService,
      inject: [DatabaseService, JobQueue, ANALYSIS_PROVIDER],
      useFactory: (db: DatabaseService, queue: JobQueue, provider: AnalysisProvider | null) =>
        new AnalysisService(db.database, queue, provider !== null),
    },
    {
      provide: IncidentService,
      inject: [DatabaseService, AnalysisService],
      useFactory: (db: DatabaseService, analysis: AnalysisService) =>
        new IncidentService(db.database, (tx, i) => analysis.enqueueInTransaction(tx, i.organizationId, i.incidentId, i.version, i.createdBy)),
    },
    {
      provide: JOB_WORKER,
      inject: [DatabaseService, JobQueue, APP_CONFIG, ANALYSIS_PROVIDER],
      useFactory: (db: DatabaseService, queue: JobQueue, config: AppConfig, provider: AnalysisProvider | null) => {
        if (!provider) return null;
        const log = createLogger(config.logLevel);
        return new JobWorker(db.database, queue, [new AnalysisJobHandler(db.database, provider)], {
          // The lease must outlive the provider timeout: there is no heartbeat.
          leaseSeconds: Math.ceil(config.ai.timeoutMs / 1000) + 30,
          pollIntervalMs: 2000,
          backoffSeconds: exponentialBackoff(5, 300),
          log: (m, f) => log.info(m, f),
        });
      },
    },
    WorkerLifecycle,
    {
      provide: ApiHandlers,
      inject: [AuthService, OrganizationService, IncidentService, AnalysisService, APP_CONFIG],
      useFactory: (auth: AuthService, orgs: OrganizationService, incidents: IncidentService, analysis: AnalysisService, config: AppConfig) =>
        new ApiHandlers(auth, orgs, incidents, analysis, {
          allowedOrigins: config.http.corsOrigins,
          secureCookies: config.nodeEnv === "production",
          sessionTtlSeconds: config.auth.sessionTtlSeconds,
        }),
    },
  ],
})
export class ApiModule {}
