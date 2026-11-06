import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { createClient, type RedisClientType } from "redis";
import { RateLimiterUnavailableError, SlidingWindowLimiter, type RateLimiter } from "./rate-limiter";
import { RedisRateLimiter, ResilientRedisRateLimiter, type RateLimitPolicy } from "./redis-rate-limiter";
import { RedisConnectionProvider } from "./redis-connection";
import type { AppConfig } from "../config/env";
import { Secret } from "../config/secret";
import { AlertWebhookHandlers } from "../alerts/webhook-handlers";
import type { AlertIngestionService } from "../alerts/alert-ingestion.service";

/*
 * Run against real Redis 7. CI provides Redis 7 on 127.0.0.1:6379 and a disposable PostgreSQL test service.
 * Local: start Redis 7 and provide a loopback TEST_DATABASE_URL for the authentication integration cases.
 * TEST_DATABASE_URL=postgres://... REDIS_URL=redis://127.0.0.1:6379 npm run test:redis -w @platform/api
 * The auth Redis integration suite also creates a disposable PostgreSQL test database.
 */
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
const VALID_TOKEN = "A".repeat(43);
const IP = "192.0.2.10";
const integration = { id: "integration-test", organizationId: "org-test", name: "test", tokenHash: "hash" };
const alertPayload = {
  version: "4",
  groupKey: "{}",
  truncatedAlerts: 0,
  status: "firing",
  receiver: "test",
  alerts: [{
    status: "firing",
    labels: { alertname: "Redis outage test" },
    annotations: { summary: "Synthetic test" },
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: "0001-01-01T00:00:00Z",
    fingerprint: "redis-outage-test",
  }],
};

function makeWebhookIngestion() {
  return {
    authenticate: async (token: string) => token === VALID_TOKEN ? integration : null,
    ingest: async () => ({ accepted: 1, created: 1, resolved: 0, duplicates: 0, ignored: 0 }),
  } as unknown as AlertIngestionService;
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : 500;
  }
}

class ToggleBackend implements RateLimiter {
  unavailable = false;
  constructor(private readonly delegate: RateLimiter) {}
  async consume(key: string) { if (this.unavailable) throw new Error("ECONNREFUSED redis://secret"); return this.delegate.consume(key); }
  async peek(key: string) { if (this.unavailable) throw new Error("ECONNREFUSED redis://secret"); return this.delegate.peek(key); }
  async reset(key: string) { if (this.unavailable) throw new Error("ECONNREFUSED redis://secret"); return this.delegate.reset(key); }
}

describe("RedisRateLimiter (real Redis)", () => {
  let redis: RedisClientType;
  let secondary: RedisClientType;
  let testPrefix: string;

  const limiter = (policy: RateLimitPolicy, limit = 2, windowMs = 10_000, client: RedisClientType = redis) =>
    new RedisRateLimiter(async () => client, limit, windowMs, policy, testPrefix);

  beforeAll(async () => {
    redis = createRedisTestClient();
    await redis.connect();
    secondary = createRedisTestClient();
    await secondary.connect();
    testPrefix = `iip:test:redis-rate-limiter:${randomUUID()}`;
  });

  afterAll(async () => {
    for await (const keys of redis.scanIterator({ MATCH: `${testPrefix}:*`, COUNT: 100 })) {
      if (keys.length > 0) await redis.del(keys);
    }
    await Promise.all([redis.quit(), secondary.quit()]);
  });

  it("isolates the same identity across all seven policy namespaces and resets only one policy", async () => {
    const policies: RateLimitPolicy[] = [
      "login-ip", "login-account", "register-ip", "alertmanager-ip",
      "webhook-failed-auth", "alertmanager-integration", "ai-user",
    ];
    const limiters = policies.map((policy) => limiter(policy, 1));
    for (const item of limiters) assert.equal((await item.consume(IP)).allowed, true);
    for (const item of limiters) assert.equal((await item.consume(IP)).allowed, false);

    await limiters[0]!.reset(IP);
    assert.equal((await limiters[0]!.consume(IP)).allowed, true, "reset policy is available again");
    for (const item of limiters.slice(1)) assert.equal((await item.peek(IP)).allowed, false, "other policy remains exhausted");
  });

  it("shares a policy counter across separate Redis connections and enforces concurrent requests atomically", async () => {
    const first = limiter("login-ip", 3, 10_000, redis);
    const second = limiter("login-ip", 3, 10_000, secondary);
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? first : second).consume("shared")));
    assert.equal(results.filter((result) => result.allowed).length, 3);
    assert.equal(results.filter((result) => !result.allowed).length, 17);
  });

  it("uses Redis server time even when separate clients have deliberately skewed application clocks", async () => {
    const first = limiter("register-ip", 1, 10_000, redis);
    const second = limiter("register-ip", 1, 10_000, secondary);
    const originalNow = Date.now;
    try {
      Date.now = () => 1;
      assert.equal((await first.consume("skewed-hosts")).allowed, true);
      Date.now = () => 9_000_000_000_000;
      assert.equal((await second.consume("skewed-hosts")).allowed, false);
    } finally {
      Date.now = originalNow;
    }
  });

  it("rejects without adding repeated members and returns a positive retry-after", async () => {
    const item = limiter("ai-user", 1, 2_000);
    assert.equal((await item.consume("user")).allowed, true);
    const rejected = await item.consume("user");
    assert.equal(rejected.allowed, false);
    assert.ok(rejected.retryAfterSeconds >= 1);
    assert.equal(await item.peek("user").then((r) => r.allowed), false);
    assert.equal(await redis.zCard(`${testPrefix}:ai-user:${createHash("sha256").update("user").digest("hex")}`), 1);
  });

  it("peek does not increment and reset deletes only its namespaced key", async () => {
    const login = limiter("login-account", 2);
    const register = limiter("register-ip", 2);
    assert.equal((await login.peek("same")).allowed, true);
    await login.consume("same");
    await login.consume("same");
    await register.consume("same");
    assert.equal((await login.peek("same")).allowed, false);
    assert.equal((await register.peek("same")).allowed, true);
    await login.reset("same");
    assert.equal((await login.peek("same")).allowed, true);
    assert.equal((await register.peek("same")).allowed, true);
  });

  it("sets an actual Redis TTL and expires the sliding window", async () => {
    const item = limiter("alertmanager-ip", 1, 180);
    const identity = "ttl-identity";
    await item.consume(identity);
    const key = `${testPrefix}:alertmanager-ip:${createHash("sha256").update(identity).digest("hex")}`;
    const ttl = await redis.pTTL(key);
    assert.ok(ttl > 0 && ttl <= 180, `expected PTTL in (0, 180], got ${ttl}`);
    await delay(220);
    assert.equal((await item.consume(identity)).allowed, true);
  });

  it("does not extend Redis TTL when rejected requests or peeks do not add a member", async () => {
    const item = limiter("login-account", 1, 2_000);
    const identity = "ttl-not-extended";
    await item.consume(identity);
    await delay(300);
    const key = `${testPrefix}:login-account:${createHash("sha256").update(identity).digest("hex")}`;
    const before = await redis.pTTL(key);
    assert.ok(before > 0 && before < 1_900);
    assert.equal((await item.consume(identity)).allowed, false);
    await item.peek(identity);
    const after = await redis.pTTL(key);
    assert.ok(after > 0 && after <= before + 100, `rejected/peek calls must not extend TTL: before=${before}, after=${after}`);
  });

  it("expires scores once they are beyond the sliding-window boundary", async () => {
    const item = limiter("alertmanager-integration", 1, 250);
    assert.equal((await item.consume("boundary")).allowed, true);
    assert.equal((await item.consume("boundary")).allowed, false);
    await delay(270);
    assert.equal((await item.consume("boundary")).allowed, true);
  });

  it("returns exactly one second for a rejected request with less than one second left", async () => {
    const item = limiter("webhook-failed-auth", 1, 1_000);
    assert.equal((await item.consume("one-second-boundary")).allowed, true);
    await delay(200); // leave strictly less than one second in the window
    const rejected = await item.consume("one-second-boundary");
    assert.deepEqual(rejected, { allowed: false, retryAfterSeconds: 1 });
  });

  it("fails closed and falls back to memory for the two Alertmanager policies", async () => {
    const failingRedis: RateLimiter = {
      consume: async () => { throw new Error("Redis command failed"); },
      peek: async () => { throw new Error("Redis command failed"); },
      reset: async () => { throw new Error("Redis command failed"); },
    };
    const critical = new ResilientRedisRateLimiter(failingRedis, new SlidingWindowLimiter(2, 10_000), "fail-closed", 60);
    const alertIp = new ResilientRedisRateLimiter(failingRedis, new SlidingWindowLimiter(2, 10_000), "fail-open");
    const alertIntegration = new ResilientRedisRateLimiter(failingRedis, new SlidingWindowLimiter(2, 10_000), "fail-open");
    assert.deepEqual(await critical.consume("failed-auth"), { allowed: false, retryAfterSeconds: 60 });
    assert.equal((await alertIp.consume("ip")).allowed, true);
    assert.equal((await alertIp.consume("ip")).allowed, true);
    assert.equal((await alertIp.consume("ip")).allowed, false);
    assert.equal((await alertIntegration.consume("integration")).allowed, true);
  });

  it("does not claim a fail-closed reset succeeded when Redis reset fails", async () => {
    const failingRedis: RateLimiter = {
      consume: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      peek: async () => ({ allowed: true, retryAfterSeconds: 0 }),
      reset: async () => { throw new Error("connection details must not escape"); },
    };
    const resilient = new ResilientRedisRateLimiter(failingRedis, new SlidingWindowLimiter(2, 10_000), "fail-closed");
    await assert.rejects(() => resilient.reset("account|ip"), RateLimiterUnavailableError);
  });

  it("bounds initial connection refusal and deduplicates concurrent connect attempts", async () => {
    const provider = new RedisConnectionProvider({
      redis: { url: new Secret("redis://127.0.0.1:1") },
      logLevel: "error",
    } as AppConfig);
    const started = Date.now();
    const clients = await Promise.all(Array.from({ length: 8 }, () => provider.getClient()));
    assert.ok(clients.every((client) => client === null));
    assert.ok(Date.now() - started < 2_500, `connection attempts exceeded bound: ${Date.now() - started}ms`);
    await provider.onApplicationShutdown();
  });

  it("retires a client and reconnects after its cooldown (not a Redis server-loss test)", async () => {
    const provider = new RedisConnectionProvider({
      redis: { url: new Secret(process.env.REDIS_URL ?? "redis://127.0.0.1:6379") },
      logLevel: "error",
    } as AppConfig);
    const first = await provider.getClient();
    assert.ok(first);
    provider.retireClient(first);
    assert.equal(await provider.getClient(), null, "reconnect is deferred during the retirement cooldown");
    await delay(1_050);
    const recovered = await provider.getClient();
    assert.ok(recovered);
    assert.notEqual(recovered, first);
    assert.equal(await recovered.ping(), "PONG");
    await provider.onApplicationShutdown();
  });

  it("shutdown aborts an active Redis handshake and closes its socket", async () => {
    const acceptedSocket: { current: Socket | null } = { current: null };
    let resolveAccepted!: () => void;
    let resolveSocketClosed!: () => void;
    const accepted = new Promise<void>((resolve) => { resolveAccepted = resolve; });
    const socketClosed = new Promise<void>((resolve) => { resolveSocketClosed = resolve; });
    const server = createServer((socket) => {
      acceptedSocket.current = socket;
      socket.on("error", () => undefined);
      socket.once("close", resolveSocketClosed);
      // Deliberately do not answer the Redis HELLO handshake: the client remains in its connecting state.
      resolveAccepted();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const provider = new RedisConnectionProvider({
      redis: { url: new Secret(`redis://127.0.0.1:${address.port}`) },
      logLevel: "error",
    } as AppConfig);

    try {
      const connecting = provider.getClient();
      await accepted;
      const started = Date.now();
      await provider.onApplicationShutdown();
      assert.equal(await connecting, null);
      const peerObservedClose = await Promise.race([
        socketClosed.then(() => true),
        delay(250).then(() => false),
      ]);
      assert.ok(peerObservedClose && acceptedSocket.current?.destroyed, "shutdown must close the connecting TCP socket");
      assert.ok(Date.now() - started < 1_000, "shutdown must not wait for the five-second handshake deadline");
    } finally {
      acceptedSocket.current?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("REDIS_URL unset leaves the in-memory limiter functional", async () => {
    const provider = new RedisConnectionProvider({ redis: null, logLevel: "error" } as AppConfig);
    assert.equal(provider.isConfigured(), false);
    assert.equal(await provider.getClient(), null);
    const memory = new SlidingWindowLimiter(1, 10_000);
    assert.equal((await memory.consume("unset-redis")).allowed, true);
    assert.equal((await memory.consume("unset-redis")).allowed, false);
  });

  it("valid Alertmanager credentials use memory fallback during Redis outage; invalid credentials still fail closed", async () => {
    const ipBackend = new ToggleBackend(limiter("alertmanager-ip", 2));
    const failedBackend = new ToggleBackend(limiter("webhook-failed-auth", 1, 300_000));
    const integrationBackend = new ToggleBackend(limiter("alertmanager-integration", 2));
    ipBackend.unavailable = true;
    failedBackend.unavailable = true;
    integrationBackend.unavailable = true;
    const handler = new AlertWebhookHandlers(makeWebhookIngestion(), {
      ipLimiter: new ResilientRedisRateLimiter(ipBackend, new SlidingWindowLimiter(2, 60_000), "fail-open"),
      failedAuthLimiter: new ResilientRedisRateLimiter(failedBackend, new SlidingWindowLimiter(1, 300_000), "fail-closed"),
      integrationLimiter: new ResilientRedisRateLimiter(integrationBackend, new SlidingWindowLimiter(2, 60_000), "fail-open"),
    });
    const request = (token: string, ip: string) => handler.alertmanager({
      ip,
      headers: { authorization: `Bearer ${token}` },
      readJson: async () => alertPayload,
    });

    assert.equal(await statusOf(request(VALID_TOKEN, "198.51.100.1")), 200);
    assert.equal(await statusOf(request("B".repeat(43), "198.51.100.2")), 503);

    // Redis has recovered: invalid credentials are counted again, exhausted budgets reject before credential lookup.
    ipBackend.unavailable = false;
    failedBackend.unavailable = false;
    integrationBackend.unavailable = false;
    assert.equal(await statusOf(request("C".repeat(43), "198.51.100.3")), 401);
    assert.equal(await statusOf(request("D".repeat(43), "198.51.100.3")), 503);
    assert.equal(await statusOf(request(VALID_TOKEN, "198.51.100.4")), 200);
  });
});
