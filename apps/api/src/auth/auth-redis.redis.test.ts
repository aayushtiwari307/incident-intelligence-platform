import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { RateLimiterUnavailableError, SlidingWindowLimiter, type RateLimiter } from "../http/rate-limiter";
import { RedisRateLimiter, ResilientRedisRateLimiter } from "../http/redis-rate-limiter";
import { createTestApp, PASSWORD, type TestApp } from "../test-support/app-harness";

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

class ResetFailureBackend implements RateLimiter {
  constructor(private readonly delegate: RateLimiter) {}
  consume(key: string) { return this.delegate.consume(key); }
  peek(key: string) { return this.delegate.peek(key); }
  async reset(_key: string): Promise<void> { throw new RateLimiterUnavailableError(); }
}

describe("authentication with real Redis-backed rate limiters (PostgreSQL + Redis)", () => {
  let redis: RedisClientType;
  let app: TestApp | undefined;
  let prefix: string;

  beforeAll(async () => {
    redis = createRedisTestClient();
    await redis.connect();
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (prefix) {
      for await (const keys of redis.scanIterator({ MATCH: `${prefix}:*`, COUNT: 100 })) {
        if (keys.length > 0) await redis.del(keys);
      }
    }
  });

  afterAll(async () => {
    await redis.quit();
  });

  it("successful login resets only the Redis account+IP counter, not the Redis IP counter", async () => {
    prefix = `iip:test:auth-redis:${randomUUID()}`;
    const loginIp = new ResilientRedisRateLimiter(
      new RedisRateLimiter(async () => redis, 2, 900_000, "login-ip", prefix),
      new SlidingWindowLimiter(2, 900_000),
      "fail-closed",
    );
    const loginAccount = new ResilientRedisRateLimiter(
      new RedisRateLimiter(async () => redis, 2, 900_000, "login-account", prefix),
      new SlidingWindowLimiter(2, 900_000),
      "fail-closed",
    );
    app = await createTestApp({
      authRateLimiters: {
        loginIp,
        loginAccount,
        registerIp: new SlidingWindowLimiter(100, 3_600_000),
      },
    });
    await app.register("redis-reset-success@example.com");
    const meta = { ip: "198.51.100.30" };

    await assert.rejects(() => app!.auth.login({ email: "redis-reset-success@example.com", password: "incorrect" }, meta));
    const authenticated = await app.auth.login({ email: "redis-reset-success@example.com", password: PASSWORD }, meta);
    assert.ok(authenticated.token);
    assert.equal((await loginAccount.peek("redis-reset-success@example.com|198.51.100.30")).allowed, true);
    assert.equal((await loginIp.peek("198.51.100.30")).allowed, false);
  });

  it("does not issue a session when the account reset returns a simulated Redis failure", async () => {
    prefix = `iip:test:auth-reset-failure:${randomUUID()}`;
    const loginIp = new ResilientRedisRateLimiter(
      new RedisRateLimiter(async () => redis, 5, 900_000, "login-ip", prefix),
      new SlidingWindowLimiter(5, 900_000),
      "fail-closed",
    );
    const accountBackend = new ResetFailureBackend(
      new RedisRateLimiter(async () => redis, 1, 900_000, "login-account", prefix),
    );
    const loginAccount = new ResilientRedisRateLimiter(
      accountBackend,
      new SlidingWindowLimiter(1, 900_000),
      "fail-closed",
    );
    app = await createTestApp({
      authRateLimiters: {
        loginIp,
        loginAccount,
        registerIp: new SlidingWindowLimiter(100, 3_600_000),
      },
    });
    await app.register("redis-reset-failure@example.com");
    const before = Number((await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM auth_sessions"))[0]?.n);
    await assert.rejects(
      () => app!.auth.login({ email: "redis-reset-failure@example.com", password: PASSWORD }, { ip: "198.51.100.31" }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.equal((error as { status?: number }).status, 503);
        assert.ok(!(error as Error).message.includes("Redis"));
        return true;
      },
    );
    const after = Number((await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM auth_sessions"))[0]?.n);
    assert.equal(after, before, "the failed reset must not create an auth session");
    assert.equal((await new RedisRateLimiter(async () => redis, 1, 900_000, "login-account", prefix).peek("redis-reset-failure@example.com|198.51.100.31")).allowed, false,
      "the Redis counter remains until its normal expiry and is not reported as reset");
  });
});
