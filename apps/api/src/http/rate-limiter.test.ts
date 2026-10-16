import assert from "node:assert/strict";
import { SlidingWindowLimiter } from "./rate-limiter";

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

describe("SlidingWindowLimiter", () => {
  it("allows up to the limit, then rejects with a retry hint", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(3, 60_000, c.now);
    for (let i = 0; i < 3; i++) assert.equal(limiter.consume("k").allowed, true);
    const blocked = limiter.consume("k");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 60);
  });

  it("lets attempts through again as the window slides", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 10_000, c.now);
    limiter.consume("k");
    c.advance(6_000);
    limiter.consume("k");
    assert.equal(limiter.consume("k").allowed, false);
    c.advance(4_001); // first attempt is now outside the window
    assert.equal(limiter.consume("k").allowed, true);
    assert.equal(limiter.consume("k").allowed, false);
  });

  it("does not extend the block when rejected attempts keep coming", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(1, 10_000, c.now);
    limiter.consume("k");
    for (let i = 0; i < 20; i++) {
      c.advance(400);
      assert.equal(limiter.consume("k").allowed, false);
    }
    c.advance(2_100); // 10_100 ms after the single counted attempt
    assert.equal(limiter.consume("k").allowed, true);
  });

  it("tracks keys independently and supports reset", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, clock().now);
    assert.equal(limiter.consume("a").allowed, true);
    assert.equal(limiter.consume("a").allowed, false);
    assert.equal(limiter.consume("b").allowed, true);
    limiter.reset("a");
    assert.equal(limiter.consume("a").allowed, true);
  });

  it("bounds memory by evicting the least recently used keys", () => {
    const limiter = new SlidingWindowLimiter(1, 60_000, clock().now, 100);
    for (let i = 0; i < 1_000; i++) limiter.consume(`ip-${i}`);
    assert.ok(limiter.size <= 100);
  });

  it("peek reports the limit without counting an attempt", () => {
    const c = clock();
    const limiter = new SlidingWindowLimiter(2, 10_000, c.now);
    assert.equal(limiter.peek("k").allowed, true);
    assert.equal(limiter.peek("k").allowed, true); // peeking never consumes
    limiter.consume("k");
    limiter.consume("k");
    const blocked = limiter.peek("k");
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSeconds, 10);
    c.advance(10_001);
    assert.equal(limiter.peek("k").allowed, true);
  });
});
