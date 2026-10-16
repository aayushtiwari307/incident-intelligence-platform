import path from "node:path";
import type { MeDto } from "@platform/shared";
import { AuthService, type AuthContext } from "../auth/auth.service";
import { PasswordHasher } from "../auth/password";
import { Database } from "../common/sql";
import { runMigrations } from "../db/migrate/runner";
import { AlertIngestionService } from "../alerts/alert-ingestion.service";
import { IntegrationService } from "../alerts/integration.service";
import { AlertWebhookHandlers } from "../alerts/webhook-handlers";
import { AnalysisJobHandler } from "../analysis/analysis.handler";
import { AnalysisService } from "../analysis/analysis.service";
import type { AnalysisProvider } from "../analysis/provider";
import { JobQueue } from "../jobs/job-queue";
import { JobWorker } from "../jobs/job-worker";
import { IncidentService } from "../incidents/incident.service";
import { OrganizationService } from "../organizations/organization.service";
import { SlidingWindowLimiter } from "../http/rate-limiter";
import { ApiHandlers } from "../http/api-handlers";
import { createTestDatabase, type TestDatabase } from "./session-factory";

export const PASSWORD = "correct horse battery staple";

export interface RegisteredUser {
  auth: AuthContext;
  token: string;
  me: MeDto;
}

export interface TestApp {
  testDb: TestDatabase;
  database: Database;
  auth: AuthService;
  organizations: OrganizationService;
  incidents: IncidentService;
  handlers: ApiHandlers;
  integrations: IntegrationService;
  ingestion: AlertIngestionService;
  /** The webhook handler with its own (generous by default) limiters; tests lower them through `webhookLimiters`. */
  webhook: AlertWebhookHandlers;
  webhookLimiters: { ip: SlidingWindowLimiter; failedAuth: SlidingWindowLimiter; integration: SlidingWindowLimiter };
  queue: JobQueue;
  analysis: AnalysisService;
  /** A worker over the real handler; tests drive it with runOnce(). Null when no provider was supplied. */
  worker: JobWorker | null;
  /** Builds another worker (to prove concurrent workers never double-process). */
  newWorker(workerId: string): JobWorker;
  limiters: { loginIp: SlidingWindowLimiter; loginAccount: SlidingWindowLimiter; registerIp: SlidingWindowLimiter };
  /** Registers a user (who becomes owner of a new organization) and returns their authenticated context. */
  register(email: string, organizationName?: string, displayName?: string): Promise<RegisteredUser>;
  /** Registers a user, then makes them a member of `owner`'s organization with `role` via the real invite flow. */
  join(owner: RegisteredUser, email: string, role: "viewer" | "responder" | "admin"): Promise<RegisteredUser>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  limits?: { loginIp?: number; loginAccount?: number; registerIp?: number };
  sessionTtlSeconds?: number;
  /** Supplying a provider turns the AI feature on (otherwise it is off, like AI_PROVIDER=none). */
  provider?: AnalysisProvider;
  workerLeaseSeconds?: number;
  webhookLimits?: { ip?: number; failedAuth?: number; integration?: number };
  /** Clock for startsAt range validation (default: real time). */
  now?: () => Date;
}

/** A complete service stack on a fresh real PostgreSQL database with all migrations applied. */
export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  const testDb = await createTestDatabase();
  await runMigrations(testDb.connect, { mode: "apply", directory: path.resolve(__dirname, "../../migrations") });

  const database = new Database(testDb.pool);
  const limiters = {
    loginIp: new SlidingWindowLimiter(options.limits?.loginIp ?? 10_000, 900_000),
    loginAccount: new SlidingWindowLimiter(options.limits?.loginAccount ?? 10_000, 900_000),
    registerIp: new SlidingWindowLimiter(options.limits?.registerIp ?? 10_000, 900_000),
  };
  const auth = new AuthService(database, new PasswordHasher({ N: 2 ** 10, r: 8, p: 1 }), {
    sessionTtlSeconds: options.sessionTtlSeconds ?? 3600,
    loginIpLimiter: limiters.loginIp,
    loginAccountLimiter: limiters.loginAccount,
    registerIpLimiter: limiters.registerIp,
  });
  const organizations = new OrganizationService(database, 7 * 24 * 3600);
  const queue = new JobQueue(database);
  const analysis = new AnalysisService(database, queue, options.provider !== undefined);
  const incidents = new IncidentService(database, (tx, i) => analysis.enqueueInTransaction(tx, i.organizationId, i.incidentId, i.version, i.createdBy));
  const newWorker = (workerId: string) =>
    new JobWorker(database, queue, options.provider ? [new AnalysisJobHandler(database, options.provider)] : [], {
      workerId,
      leaseSeconds: options.workerLeaseSeconds ?? 60,
      pollIntervalMs: 20,
      backoffSeconds: () => 0, // retries are immediately due in tests; backoff itself has its own unit test
    });
  const worker = options.provider ? newWorker("test-worker") : null;

  const register = async (email: string, organizationName = `${email} org`, displayName = email.split("@")[0] as string) => {
    const result = await auth.register({ email, password: PASSWORD, displayName, organizationName }, { ip: "203.0.113.1" });
    const context = (await auth.authenticate(result.token)) as AuthContext;
    return { auth: context, token: result.token, me: result.me };
  };

  const join = async (owner: RegisteredUser, email: string, role: "viewer" | "responder" | "admin") => {
    const invite = await organizations.createInvite(owner.auth, { email, role });
    const user = await register(email, `${email} personal org`);
    await organizations.acceptInvite(user.auth, { token: invite.token });
    const context = (await auth.authenticate(user.token)) as AuthContext; // now active in the inviter's organization
    return { ...user, auth: context };
  };

  const integrations = new IntegrationService(database);
  const ingestion = new AlertIngestionService(database, incidents);
  const webhookLimiters = {
    ip: new SlidingWindowLimiter(options.webhookLimits?.ip ?? 10_000, 60_000),
    failedAuth: new SlidingWindowLimiter(options.webhookLimits?.failedAuth ?? 10_000, 300_000),
    integration: new SlidingWindowLimiter(options.webhookLimits?.integration ?? 10_000, 60_000),
  };
  const webhook = new AlertWebhookHandlers(ingestion, {
    ipLimiter: webhookLimiters.ip,
    failedAuthLimiter: webhookLimiters.failedAuth,
    integrationLimiter: webhookLimiters.integration,
    ...(options.now ? { now: options.now } : {}),
  });

  const handlers = new ApiHandlers(auth, organizations, incidents, analysis, integrations, {
    allowedOrigins: ["http://localhost:3000"],
    secureCookies: false,
    sessionTtlSeconds: options.sessionTtlSeconds ?? 3600,
  });

  return { testDb, database, auth, organizations, incidents, handlers, integrations, ingestion, webhook, webhookLimiters, queue, analysis, worker, newWorker, limiters, register, join, close: () => testDb.drop() };
}
