import assert from "node:assert/strict";
import { GitHubBudget, KeyedTokenBucket, type HeaderReader } from "./github-budget";

function headers(values: Record<string, string>): HeaderReader {
  return { get: (name) => values[name.toLowerCase()] ?? null };
}
const NONE = headers({});
const T0 = 1_000_000_000_000;

describe("GitHubBudget", () => {
  it("allows calls while the quota is unknown", () => {
    const budget = new GitHubBudget();
    assert.deepEqual(budget.tryAcquire(T0), { ok: true });
  });

  it("stops at the reserve using GitHub's own headers and resumes after the reset time", () => {
    const budget = new GitHubBudget({ reserve: 5 });
    budget.record(T0, 200, headers({ "x-ratelimit-remaining": "5", "x-ratelimit-reset": String((T0 + 120_000) / 1000) }));
    const blocked = budget.check(T0 + 1000);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) {
      assert.equal(blocked.reason, "rate_limited");
      assert.equal(blocked.retryAfterMs, 119_000);
    }
    assert.deepEqual(budget.check(T0 + 120_000), { ok: true });
  });

  it("consumes optimistically so concurrent callers cannot all pass on the last calls", () => {
    const budget = new GitHubBudget({ reserve: 0 });
    budget.record(T0, 200, headers({ "x-ratelimit-remaining": "2", "x-ratelimit-reset": String((T0 + 60_000) / 1000) }));
    assert.equal(budget.tryAcquire(T0).ok, true);
    assert.equal(budget.tryAcquire(T0).ok, true);
    assert.equal(budget.tryAcquire(T0).ok, false);
  });

  it("blocks on 429 for at least the minimum and honours a longer Retry-After, capped at the maximum", () => {
    const a = new GitHubBudget({ minBlockMs: 60_000, maxBlockMs: 3_600_000 });
    a.record(T0, 429, NONE);
    const first = a.check(T0 + 1);
    assert.equal(first.ok, false);
    if (!first.ok) assert.equal(first.retryAfterMs, 59_999);

    const b = new GitHubBudget();
    b.record(T0, 429, headers({ "retry-after": "300" }));
    const second = b.check(T0);
    if (!second.ok) assert.equal(second.retryAfterMs, 300_000);

    const c = new GitHubBudget({ maxBlockMs: 3_600_000 });
    c.record(T0, 429, headers({ "retry-after": "999999999" }));
    const third = c.check(T0);
    if (!third.ok) assert.equal(third.retryAfterMs, 3_600_000);
  });

  it("briefly pauses when the quota is low but the reset header is missing", () => {
    const budget = new GitHubBudget({ reserve: 5, minBlockMs: 30_000 });
    budget.record(T0, 200, headers({ "x-ratelimit-remaining": "5" }));
    const blocked = budget.check(T0 + 1);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.retryAfterMs, 29_999);
    assert.equal(budget.check(T0 + 30_001).ok, true, "allow a conservative probe after the minimum pause");
  });

  it("treats 403 as rate limiting only when GitHub says the quota is exhausted", () => {
    const limited = new GitHubBudget();
    limited.record(T0, 403, headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String((T0 + 90_000) / 1000) }));
    assert.equal(limited.check(T0).ok, false);

    const forbidden = new GitHubBudget();
    forbidden.record(T0, 403, headers({ "x-ratelimit-remaining": "40" }));
    assert.equal(forbidden.check(T0).ok, true);
  });

  it("opens the circuit breaker after consecutive failures, then closes it", () => {
    const budget = new GitHubBudget({ failureThreshold: 3, breakerMs: 60_000 });
    budget.record(T0, 503, NONE);
    budget.record(T0, 0, NONE);
    assert.equal(budget.check(T0).ok, true);
    budget.record(T0, 500, NONE);
    const open = budget.check(T0 + 10);
    assert.equal(open.ok, false);
    if (!open.ok) assert.equal(open.reason, "circuit_open");
    assert.equal(budget.check(T0 + 60_000).ok, true);
  });

  it("does not let 404 or 304 count as failures, and a success resets the failure count", () => {
    const budget = new GitHubBudget({ failureThreshold: 3 });
    budget.record(T0, 500, NONE);
    budget.record(T0, 500, NONE);
    budget.record(T0, 304, NONE);
    budget.record(T0, 500, NONE);
    budget.record(T0, 404, NONE);
    budget.record(T0, 500, NONE);
    assert.equal(budget.check(T0).ok, true);
  });

  it("being rate limited does not open the circuit breaker", () => {
    const budget = new GitHubBudget({ failureThreshold: 1, minBlockMs: 1000 });
    budget.record(T0, 429, NONE);
    const later = budget.check(T0 + 2000);
    assert.equal(later.ok, true);
  });

  it("ignores malformed header values", () => {
    const budget = new GitHubBudget({ reserve: 5 });
    budget.record(T0, 200, headers({ "x-ratelimit-remaining": "-3", "x-ratelimit-reset": "soon", "retry-after": "1e9" }));
    assert.equal(budget.check(T0).ok, true);
  });
});

describe("KeyedTokenBucket", () => {
  it("allows a burst up to capacity, then refuses with an accurate retry delay", () => {
    const bucket = new KeyedTokenBucket({ capacity: 3, refillPerMs: 3 / 600_000 });
    for (let i = 0; i < 3; i++) assert.equal(bucket.tryTake("org-a", T0).ok, true);
    const refused = bucket.tryTake("org-a", T0);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.retryAfterMs, 200_000);
  });

  it("refills over time and never exceeds capacity", () => {
    const bucket = new KeyedTokenBucket({ capacity: 2, refillPerMs: 1 / 1000 });
    bucket.tryTake("k", T0);
    bucket.tryTake("k", T0);
    assert.equal(bucket.tryTake("k", T0).ok, false);
    assert.equal(bucket.tryTake("k", T0 + 1000).ok, true);
    assert.equal(bucket.tryTake("k", T0 + 10_000_000).ok, true);
    assert.equal(bucket.tryTake("k", T0 + 10_000_000).ok, true);
    assert.equal(bucket.tryTake("k", T0 + 10_000_000).ok, false);
  });

  it("keeps organizations independent", () => {
    const bucket = new KeyedTokenBucket({ capacity: 1, refillPerMs: 1 / 60_000 });
    assert.equal(bucket.tryTake("org-a", T0).ok, true);
    assert.equal(bucket.tryTake("org-a", T0).ok, false);
    assert.equal(bucket.tryTake("org-b", T0).ok, true);
  });

  it("bounds its memory by evicting the least recently used key", () => {
    const bucket = new KeyedTokenBucket({ capacity: 1, refillPerMs: 1 / 60_000, maxKeys: 3 });
    for (const key of ["a", "b", "c", "d", "e"]) bucket.tryTake(key, T0);
    assert.equal(bucket.size, 3);
  });

  it("tolerates a clock that moves backwards and rejects invalid options", () => {
    const bucket = new KeyedTokenBucket({ capacity: 1, refillPerMs: 1 / 1000 });
    assert.equal(bucket.tryTake("k", T0).ok, true);
    assert.equal(bucket.tryTake("k", T0 - 5000).ok, false);
    assert.throws(() => new KeyedTokenBucket({ capacity: 0, refillPerMs: 1 }));
    assert.throws(() => new KeyedTokenBucket({ capacity: 1, refillPerMs: 0 }));
  });
});
