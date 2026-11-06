import assert from "node:assert/strict";
import { RateLimiterUnavailableError, SlidingWindowLimiter } from "./rate-limiter";
import { RedisRateLimiter } from "./redis-rate-limiter";
import { connectRedisClientWithDeadline } from "./redis-connection";
import type { RedisClientType } from "redis";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit, then rejects with a retry hint", async () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(3, 60_000, c.now);
    for (let i = 0; i < 3; i++) assert.equal((await limiter.consume("k")).allowed, true);
    const blocked = await limiter.consume("k");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 60);
  });

  it("lets attempts through again as the window slides", async () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 10_000, c.now);
    await limiter.consume("k");
    c.advance(6_000);
    await limiter.consume("k");
    assert.equal((await limiter.consume("k")).allowed, false);
    c.advance(4_001); // first attempt is now outside the window
    assert.equal((await limiter.consume("k")).allowed, true);
    assert.equal((await limiter.consume("k")).allowed, false);
  });

  it("does not extend the block when rejected attempts keep coming", async () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 10_000, c.now);
    await limiter.consume("k");
    for (let i = 0; i < 20; i++) {
      c.advance(400);
      assert.equal((await limiter.consume("k")).allowed, false);
    }
    c.advance(2_100); // 10_100 ms after the single counted attempt
    assert.equal((await limiter.consume("k")).allowed, true);
  });

  it("tracks keys independently and supports reset", async () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, clock().now);
    assert.equal((await limiter.consume("a")).allowed, true);
    assert.equal((await limiter.consume("a")).allowed, false);
    assert.equal((await limiter.consume("b")).allowed, true);
    await limiter.reset("a");
    assert.equal((await limiter.consume("a")).allowed, true);
  });

  it("bounds memory by evicting the least recently used keys", async () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, clock().now, 100);
    for (let i = 0; i < 1_000; i++) await limiter.consume(`ip-${i}`);
    assert.ok(limiter.size <= 100);
  });

  it("peek reports the limit without counting an attempt", async () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 10_000, c.now);
    assert.equal((await limiter.peek("k")).allowed, true);
    assert.equal((await limiter.peek("k")).allowed, true); // peeking never consumes
    await limiter.consume("k");
    await limiter.consume("k");
    const blocked = await limiter.peek("k");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 10);
    c.advance(10_001);
    assert.equal((await limiter.peek("k")).allowed, true);
  });
});


describe("RedisRateLimiter command deadline (no Redis required)", () => {
  it("retires the client and aborts an in-flight command that exceeds the absolute deadline", async () => {
    let rejectCommand: ((error: Error) => void) | undefined;
    let commandSettled = false;
    let destroyed = false;
    const client = {
      isReady: true,
      eval: () => new Promise<never>((_resolve, reject) => {
        rejectCommand = reject;
      }).finally(() => {
        commandSettled = true;
      }),
      destroy: () => {
        destroyed = true;
        rejectCommand?.(new Error("socket destroyed by command deadline"));
      },
    } as unknown as RedisClientType;
    const limiter = new RedisRateLimiter(
      async () => client,
      1,
      10_000,
      "login-ip",
      "iip:test:deadline",
      (timedOutClient) => timedOutClient.destroy(),
      25,
    );
    const started = Date.now();

    await assert.rejects(() => limiter.consume("identity"), RateLimiterUnavailableError);
    await Promise.resolve();
    assert.equal(destroyed, true, "the timed-out client is actually retired, not merely raced");
    assert.equal(commandSettled, true, "destroying the client settles the underlying command promise");
    assert.ok(Date.now() - started < 500, "the operation returns within its configured hard deadline");
  });
});


describe("Redis connection handshake deadline (no Redis required)", () => {
  it("destroys a client when the full connect/HELLO handshake exceeds its absolute deadline", async () => {
    let rejectConnect: ((error: Error) => void) | undefined;
    let connectSettled = false;
    let destroyed = false;
    const client = {
      connect: () => new Promise<never>((_resolve, reject) => {
        rejectConnect = reject;
      }).finally(() => {
        connectSettled = true;
      }),
      destroy: () => {
        destroyed = true;
        rejectConnect?.(new Error("socket destroyed by connection deadline"));
      },
    } as unknown as RedisClientType;
    const started = Date.now();

    await assert.rejects(() => connectRedisClientWithDeadline(client, 25));
    await Promise.resolve();
    assert.equal(destroyed, true, "the client is actively destroyed on timeout");
    assert.equal(connectSettled, true, "destroying the client settles the underlying connect promise");
    assert.ok(Date.now() - started < 500, "the handshake returns within its configured hard deadline");
  });
});
