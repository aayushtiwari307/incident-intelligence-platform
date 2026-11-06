import { AppError, serviceUnavailable } from "../common/errors";
import type { Logger } from "../common/logger";
import type { HttpRequest, HttpResult } from "../http/http-types";
import { RateLimiterUnavailableError, type RateLimiter } from "../http/rate-limiter";
import { AlertIngestionService, toRetryableFailure } from "./alert-ingestion.service";
import { parseAlertmanagerPayload } from "./alertmanager-payload";

/** A webhook delivery as the handler sees it. The body is read lazily, AFTER authentication and rate limiting. */
export interface WebhookRequest {
  ip: string;
  headers: HttpRequest["headers"];
  /** Reads and parses the JSON body with the webhook's own limit; throws AppError for oversize/invalid bodies. */
  readJson(): Promise<unknown>;
}

export interface WebhookHandlersOptions {
  /** Every request, per client address, checked before any database work. */
  ipLimiter: RateLimiter;
  /** Failed credential attempts per client address. Gates the credential lookup once exceeded. */
  failedAuthLimiter: RateLimiter;
  /** Authenticated deliveries per integration. */
  integrationLimiter: RateLimiter;
  log?: Pick<Logger, "info" | "warn">;
  now?: () => Date;
}

const BEARER = /^Bearer ([A-Za-z0-9_-]{32,128})$/;
const NO_STORE = { "Cache-Control": "no-store" };
const CHALLENGE = { "WWW-Authenticate": 'Bearer realm="alertmanager-webhook"' };

/**
 * The server-to-server webhook. It has its own narrowly scoped Bearer authentication; it never looks at cookies and
 * never applies the browser Origin check (there is no browser), and the browser endpoints never accept this credential.
 *
 * Status codes (Alertmanager treats 2xx as delivered, retries 5xx, and does NOT retry 4xx or 429):
 *   200 committed (also for duplicates and ignored resolutions: they are successful, idempotent outcomes)
 *   401 missing/invalid/revoked credential        400 malformed payload     413 too large     415 wrong content type
 *   503 + Retry-After: rate limit, database trouble, lock timeout, truncated notification
 */
export class AlertWebhookHandlers {
  constructor(
    private readonly ingestion: AlertIngestionService,
    private readonly options: WebhookHandlersOptions,
  ) {}

  async alertmanager(req: WebhookRequest): Promise<HttpResult> {
    const { ipLimiter, failedAuthLimiter, integrationLimiter, log } = this.options;

    // 1. Cheap IP gate first. All Alertmanager backpressure is 503 + Retry-After (never 429, which Alertmanager would not retry).
    const ip = await ipLimiter.consume(req.ip);
    if (!ip.allowed) throw this.backpressure(ip.retryAfterSeconds);
    // 2. Preflight the failed-auth budget while Redis is healthy. If Redis is unavailable, defer the decision until
    // credentials are known: valid integrations may continue through the Alertmanager memory fallbacks; invalid
    // credentials still call consume() below, which is fail-closed. Memory-only mode has no strict method and is checked here.
    try {
      const failures = failedAuthLimiter.peekStrict
        ? await failedAuthLimiter.peekStrict(req.ip)
        : await failedAuthLimiter.peek(req.ip);
      if (!failures.allowed) throw this.backpressure(failures.retryAfterSeconds);
    } catch (error) {
      if (!(error instanceof RateLimiterUnavailableError)) throw error;
    }

    // 3. Credential: Authorization header only (query strings and cookies are never consulted). A wrongly shaped value is
    //    rejected without touching the database when the healthy failed-auth preflight has exhausted its budget.
    const authorization = req.headers.authorization;
    const match = typeof authorization === "string" ? BEARER.exec(authorization) : null;
    const integration = match ? await this.lookup(match[1] as string) : null;
    if (!integration) {
      const failure = await failedAuthLimiter.consume(req.ip);
      if (!failure.allowed) throw this.backpressure(failure.retryAfterSeconds);
      throw new AppError("UNAUTHENTICATED", "Invalid or revoked credentials", { headers: { ...CHALLENGE } });
    }

    const perIntegration = await integrationLimiter.consume(integration.id);
    if (!perIntegration.allowed) throw this.backpressure(perIntegration.retryAfterSeconds);

    // 3. Body, then validation. Nothing has been written yet, so a rejected request leaves no trace.
    const delivery = parseAlertmanagerPayload(await req.readJson(), (this.options.now ?? (() => new Date()))());

    // 4. One transaction; 2xx only after COMMIT.
    try {
      const response = await this.ingestion.ingest(integration, delivery);
      log?.info("alertmanager delivery committed", {
        integrationId: integration.id,
        accepted: response.accepted,
        created: response.created,
        resolved: response.resolved,
        duplicates: response.duplicates,
        ignored: response.ignored,
      });
      return { status: 200, body: response, headers: NO_STORE };
    } catch (error) {
      if (error instanceof AppError && error.code === "UNAUTHENTICATED") {
        // Revoked or rotated between the lookup and the transaction.
        const failure = await failedAuthLimiter.consume(req.ip);
        if (!failure.allowed) throw this.backpressure(failure.retryAfterSeconds);
        throw new AppError("UNAUTHENTICATED", error.message, { headers: { ...CHALLENGE } });
      }
      const failure = toRetryableFailure(error);
      if (failure instanceof AppError && failure.status >= 500) log?.warn("alertmanager delivery failed; sender should retry", { integrationId: integration.id, code: failure.code });
      throw failure;
    }
  }

  private async lookup(token: string) {
    try {
      return await this.ingestion.authenticate(token);
    } catch (error) {
      throw toRetryableFailure(error);
    }
  }

  private backpressure(retryAfterSeconds: number): AppError {
    return serviceUnavailable(retryAfterSeconds, "Too many requests; retry after the indicated delay");
  }
}
