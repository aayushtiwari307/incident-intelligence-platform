import { Module } from "@nestjs/common";
import { AlertIngestionService } from "../alerts/alert-ingestion.service";
import { IntegrationService } from "../alerts/integration.service";
import { AlertWebhookHandlers } from "../alerts/webhook-handlers";
import { AiSuggestionService } from "../ai/suggestion.service";
import { SuggestionJobHandler } from "../ai/suggestion.handler";
import { createSuggestionProvider } from "../ai/suggestion-provider-factory";
import type { SuggestionProvider } from "../ai/suggestion-provider";
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
import { AiSettingsController, AuthController, IncidentController, IntegrationController, IntegrationWebhookController, OrganizationController, WEBHOOK_BODY_LIMIT } from "./api.controllers";
import { SlidingWindowLimiter } from "./rate-limiter";
import { RealtimeHub } from "../realtime/hub";
import { REALTIME_LISTEN_CONNECTOR, RealtimeService, defaultListenConnector } from "../realtime/realtime.service";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;
const ONE_MINUTE = 60 * 1000;

// Webhook limits (per API process; see docs/integrations/alertmanager.md for what in-memory limiting does and does not give).
const WEBHOOK_IP_LIMIT_PER_MINUTE = 600;
const WEBHOOK_FAILED_AUTH_LIMIT_PER_5_MINUTES = 20;
const WEBHOOK_INTEGRATION_LIMIT_PER_MINUTE = 300;

// Allow integration tests to create many users from one local IP.
const REGISTER_IP_LIMIT = process.env.NODE_ENV === "test" ? 10_000 : 10;

/** Transport injection is private to the process; production defaults to global fetch and the fixed OpenAI URL. */
export const OPENAI_FETCH = Symbol("OPENAI_FETCH");
const ANALYSIS_PROVIDER = Symbol("ANALYSIS_PROVIDER");
const SUGGESTION_PROVIDER = Symbol("SUGGESTION_PROVIDER");

// Grounded-AI generate requests per user (and organization): a burst guard on top of the atomic daily quota.
const AI_USER_LIMIT_PER_10_MINUTES = 5;

/**
 * Wires the framework-free services to Nest. Rate limiters are in process memory: correct for a single API
 * instance, per-instance (so effectively looser) when scaled out. Moving them to Redis is the planned fix (ADR 0010).
 */
@Module({
  controllers: [AuthController, OrganizationController, IncidentController, AiSettingsController, IntegrationController, IntegrationWebhookController],
  providers: [
    { provide: OPENAI_FETCH, useValue: fetch },
    {
      provide: ANALYSIS_PROVIDER,
      inject: [APP_CONFIG, OPENAI_FETCH],
      useFactory: (config: AppConfig, fetchImpl: typeof fetch): AnalysisProvider | null =>
        createAnalysisProvider(config.ai, { fetchImpl }),
    },
    {
      provide: SUGGESTION_PROVIDER,
      inject: [APP_CONFIG, OPENAI_FETCH],
      useFactory: (config: AppConfig, fetchImpl: typeof fetch): SuggestionProvider | null => createSuggestionProvider(config.ai, { fetchImpl }),
    },
    {
      provide: AuthService,
      inject: [DatabaseService, APP_CONFIG],
      useFactory: (db: DatabaseService, config: AppConfig) =>
        new AuthService(db.database, new PasswordHasher(), {
          sessionTtlSeconds: config.auth.sessionTtlSeconds,
          loginIpLimiter: new SlidingWindowLimiter(100, FIFTEEN_MINUTES),
          loginAccountLimiter: new SlidingWindowLimiter(5, FIFTEEN_MINUTES),
          registerIpLimiter: new SlidingWindowLimiter(REGISTER_IP_LIMIT, ONE_HOUR),
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
      provide: AiSuggestionService,
      inject: [DatabaseService, JobQueue, APP_CONFIG, SUGGESTION_PROVIDER],
      useFactory: (db: DatabaseService, queue: JobQueue, config: AppConfig, provider: SuggestionProvider | null) =>
        new AiSuggestionService(db.database, queue, {
          // No provider object means no feature: the switch, the key and the provider kind are all folded into this.
          serverEnabled: provider !== null,
          dailyLimit: config.ai.suggestions.dailyRequestLimit,
          userLimiter: new SlidingWindowLimiter(AI_USER_LIMIT_PER_10_MINUTES, 10 * ONE_MINUTE),
        }),
    },
    {
      provide: IncidentService,
      inject: [DatabaseService, AnalysisService],
      useFactory: (db: DatabaseService, analysis: AnalysisService) =>
        new IncidentService(db.database, (tx, i) => analysis.enqueueInTransaction(tx, i.organizationId, i.incidentId, i.version, i.createdBy)),
    },
    { provide: IntegrationService, inject: [DatabaseService], useFactory: (db: DatabaseService) => new IntegrationService(db.database) },
    {
      provide: AlertIngestionService,
      inject: [DatabaseService, IncidentService],
      useFactory: (db: DatabaseService, incidents: IncidentService) => new AlertIngestionService(db.database, incidents),
    },
    {
      provide: AlertWebhookHandlers,
      inject: [AlertIngestionService, APP_CONFIG],
      useFactory: (ingestion: AlertIngestionService, config: AppConfig) => {
        const log = createLogger(config.logLevel);
        return new AlertWebhookHandlers(ingestion, {
          ipLimiter: new SlidingWindowLimiter(WEBHOOK_IP_LIMIT_PER_MINUTE, ONE_MINUTE),
          failedAuthLimiter: new SlidingWindowLimiter(WEBHOOK_FAILED_AUTH_LIMIT_PER_5_MINUTES, 5 * ONE_MINUTE),
          integrationLimiter: new SlidingWindowLimiter(WEBHOOK_INTEGRATION_LIMIT_PER_MINUTE, ONE_MINUTE),
          log,
        });
      },
    },
    { provide: WEBHOOK_BODY_LIMIT, inject: [APP_CONFIG], useFactory: (config: AppConfig) => config.http.webhookBodyLimitBytes },
    {
      provide: JOB_WORKER,
      inject: [DatabaseService, JobQueue, APP_CONFIG, ANALYSIS_PROVIDER, SUGGESTION_PROVIDER, IncidentService],
      useFactory: (
        db: DatabaseService,
        queue: JobQueue,
        config: AppConfig,
        provider: AnalysisProvider | null,
        suggestionProvider: SuggestionProvider | null,
        incidents: IncidentService,
      ) => {
        const log = createLogger(config.logLevel);
        const handlers = [
          ...(provider ? [new AnalysisJobHandler(db.database, provider)] : []),
          ...(suggestionProvider ? [new SuggestionJobHandler(db.database, suggestionProvider, incidents, (m, f) => log.info(m, f))] : []),
        ];
        // With every AI feature off there are no handlers and no worker: nothing can reach a provider.
        if (handlers.length === 0) return null;
        return new JobWorker(db.database, queue, handlers, {
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
      provide: RealtimeHub,
      inject: [AuthService, IncidentService, APP_CONFIG],
      useFactory: (auth: AuthService, incidents: IncidentService, config: AppConfig) =>
        new RealtimeHub(
          auth,
          { load: (organizationId, eventId) => incidents.loadRealtimeMessage(organizationId, eventId) },
          { secureCookies: config.nodeEnv === "production", log: createLogger(config.logLevel) },
        ),
    },
    { provide: REALTIME_LISTEN_CONNECTOR, inject: [APP_CONFIG], useFactory: defaultListenConnector },
    RealtimeService,
    {
      provide: ApiHandlers,
      inject: [AuthService, OrganizationService, IncidentService, AnalysisService, IntegrationService, AiSuggestionService, APP_CONFIG, RealtimeHub],
      useFactory: (auth: AuthService, orgs: OrganizationService, incidents: IncidentService, analysis: AnalysisService, integrations: IntegrationService, aiSuggestions: AiSuggestionService, config: AppConfig, hub: RealtimeHub) =>
        new ApiHandlers(auth, orgs, incidents, analysis, integrations, aiSuggestions, {
          allowedOrigins: config.http.corsOrigins,
          secureCookies: config.nodeEnv === "production",
          sessionTtlSeconds: config.auth.sessionTtlSeconds,
          onAccessChanged: () => hub.requestRevalidation(),
        }),
    },
  ],
})
export class ApiModule {}
