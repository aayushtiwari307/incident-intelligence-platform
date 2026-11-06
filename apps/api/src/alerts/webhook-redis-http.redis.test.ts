import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { toErrorResponse } from "../http/error-response";
import { readJsonBody } from "../http/webhook-body";
import { SlidingWindowLimiter, type RateLimiter } from "../http/rate-limiter";
import { RedisRateLimiter, ResilientRedisRateLimiter, type RateLimitPolicy } from "../http/redis-rate-limiter";
import { AlertWebhookHandlers } from "./webhook-handlers";
import type { AlertIngestionService } from "./alert-ingestion.service";

const REDIS_TEST_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const createRedisTestClient = () => {
  const client = createClient({
    url: REDIS_TEST_URL,
    disableOfflineQueue: true,
    commandOptions: { timeout: 3_000 },
    socket: { connectTimeout: 1_000, reconnectStrategy: () => false },
  });
  client.on("error", () => undefined);
  return client;
};
const PATH = "/api/v1/integrations/alertmanager";
const VALID_TOKEN = "A".repeat(43);
const INVALID_TOKEN = "B".repeat(43);
const INTEGRATION = { id: "redis-http-integration", organizationId: "redis-http-org", name: "redis-http", tokenHash: "test" };

class SwitchableBackend implements RateLimiter {
  unavailable = false;
  constructor(private readonly delegate: RateLimiter) {}
  async consume(key: string) {
    if (this.unavailable) throw new Error("ECONNREFUSED: redacted backend");
    return this.delegate.consume(key);
  }
  async peek(key: string) {
    if (this.unavailable) throw new Error("ECONNREFUSED: redacted backend");
    return this.delegate.peek(key);
  }
  async reset(key: string) {
    if (this.unavailable) throw new Error("ECONNREFUSED: redacted backend");
    return this.delegate.reset(key);
  }
}

describe("Alertmanager HTTP behavior with real Redis counters and simulated backend outages", () => {
  let redis: RedisClientType;
  let server: Server;
  let url: string;
  let prefix: string;
  let handler: AlertWebhookHandlers;
  let ipBackend: SwitchableBackend;
  let failedAuthBackend: SwitchableBackend;
  let integrationBackend: SwitchableBackend;
  let authenticateCalls: number;
  let committed: number;

  const payload = () => ({
    version: "4",
    status: "firing",
    groupKey: "{}",
    truncatedAlerts: 0,
    receiver: "test",
    alerts: [{
      status: "firing",
      labels: { alertname: "Redis outage HTTP test" },
      annotations: { summary: "Synthetic test" },
      startsAt: new Date(Date.now() - 60_000).toISOString(),
      endsAt: "0001-01-01T00:00:00Z",
      fingerprint: randomUUID(),
    }],
  });

  const post = (token: string, ip: string) => fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-test-client-ip": ip },
    body: JSON.stringify(payload()),
  });

  beforeAll(async () => {
    redis = createRedisTestClient();
    await redis.connect();
  });

  beforeEach(async () => {
    prefix = `iip:test:webhook-http:${randomUUID()}`;
    authenticateCalls = 0;
    committed = 0;
    const backend = (policy: RateLimitPolicy, limit: number, windowMs: number) => new SwitchableBackend(
      new RedisRateLimiter(async () => redis, limit, windowMs, policy, prefix),
    );
    ipBackend = backend("alertmanager-ip", 2, 60_000);
    failedAuthBackend = backend("webhook-failed-auth", 1, 300_000);
    integrationBackend = backend("alertmanager-integration", 2, 60_000);

    const ingestion = {
      authenticate: async (token: string) => {
        authenticateCalls += 1;
        return token === VALID_TOKEN ? INTEGRATION : null;
      },
      ingest: async () => {
        committed += 1;
        return { accepted: 1, created: 1, resolved: 0, duplicates: 0, ignored: 0 };
      },
    } as unknown as AlertIngestionService;

    handler = new AlertWebhookHandlers(ingestion, {
      ipLimiter: new ResilientRedisRateLimiter(ipBackend, new SlidingWindowLimiter(2, 60_000), "fail-open"),
      failedAuthLimiter: new ResilientRedisRateLimiter(failedAuthBackend, new SlidingWindowLimiter(1, 300_000), "fail-closed"),
      integrationLimiter: new ResilientRedisRateLimiter(integrationBackend, new SlidingWindowLimiter(2, 60_000), "fail-open"),
    });

    server = createServer((req, res) => {
      void (async () => {
        try {
          if (req.method !== "POST" || req.url !== PATH) {
            res.writeHead(404).end();
            return;
          }
          const result = await handler.alertmanager({
            ip: typeof req.headers["x-test-client-ip"] === "string" ? req.headers["x-test-client-ip"] : req.socket.remoteAddress ?? "unknown",
            headers: req.headers,
            readJson: () => readJsonBody(req, { limitBytes: 4096, timeoutMs: 2000 }),
          });
          res.writeHead(result.status, { "content-type": "application/json", ...(result.headers ?? {}) });
          res.end(JSON.stringify(result.body));
        } catch (error) {
          const response = toErrorResponse(error);
          res.writeHead(response.status, { "content-type": "application/json", ...(response.headers ?? {}) });
          res.end(JSON.stringify(response.body));
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for await (const keys of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
      if (keys.length > 0) await redis.del(keys);
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("preserves healthy Redis authentication and enforces the failed-auth budget", async () => {
    assert.equal((await post(VALID_TOKEN, "198.51.100.1")).status, 200);
    assert.equal((await post(INVALID_TOKEN, "198.51.100.2")).status, 401);
    const exhausted = await post(VALID_TOKEN, "198.51.100.2");
    assert.equal(exhausted.status, 503);
    assert.ok(Number(exhausted.headers.get("retry-after")) >= 1);
    assert.equal(authenticateCalls, 2, "healthy exhausted preflight rejects before another credential lookup");
    assert.equal(committed, 1);
  });

  it("uses both memory fallbacks and fails closed for invalid credentials during a simulated backend outage", async () => {
    ipBackend.unavailable = true;
    failedAuthBackend.unavailable = true;
    integrationBackend.unavailable = true;

    assert.equal((await post(VALID_TOKEN, "198.51.100.10")).status, 200);
    assert.equal((await post(VALID_TOKEN, "198.51.100.10")).status, 200);
    assert.equal((await post(VALID_TOKEN, "198.51.100.10")).status, 503, "the IP fallback enforces its in-memory allowance");
    assert.equal((await post(VALID_TOKEN, "198.51.100.12")).status, 503, "a fresh IP still encounters the integration fallback allowance");

    const invalid = await post(INVALID_TOKEN, "198.51.100.11");
    assert.equal(invalid.status, 503, "invalid credentials must not bypass fail-closed failed-auth policy");
    const body = await invalid.text();
    assert.ok(!body.includes("ECONNREFUSED"));
    assert.ok(!body.includes("redis://"));
    assert.equal(committed, 2);
  });

  it("returns to real Redis counters after a simulated backend outage", async () => {
    ipBackend.unavailable = true;
    failedAuthBackend.unavailable = true;
    integrationBackend.unavailable = true;
    assert.equal((await post(VALID_TOKEN, "198.51.100.20")).status, 200);
    assert.equal((await post(INVALID_TOKEN, "198.51.100.21")).status, 503);

    ipBackend.unavailable = false;
    failedAuthBackend.unavailable = false;
    integrationBackend.unavailable = false;
    assert.equal((await post(VALID_TOKEN, "198.51.100.22")).status, 200);
    assert.equal((await post(INVALID_TOKEN, "198.51.100.23")).status, 401);
    assert.equal(committed, 2);
  });
});
