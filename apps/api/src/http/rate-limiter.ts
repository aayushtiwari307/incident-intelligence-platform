export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the oldest counted attempt leaves the window. 0 when allowed. */
  retryAfterSeconds: number;
}

/**
 * Sliding-window limiter held in process memory.
 *
 * Limitation, stated plainly: the counters live in one Node process. With several API instances each has its
 * own counters, so the effective limit is multiplied. A Redis-backed limiter replaces this in Phase 4, when
 * Redis becomes a runtime dependency. Memory is bounded: at most `maxKeys` keys are tracked, oldest first out.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  /** Records one attempt for `key` and says whether it is allowed. Rejected attempts are not counted again. */
  consume(key: string): RateLimitResult {
    const now = this.now();
    const windowStart = now - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > windowStart);

    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.ceil(((recent[0] as number) + this.windowMs - now) / 1000) };
    }
    recent.push(now);
    this.hits.delete(key); // re-insert so Map order tracks recency
    this.hits.set(key, recent);
    this.evict();
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Says whether `key` is over the limit right now WITHOUT counting an attempt (used to gate on past failures). */
  peek(key: string): RateLimitResult {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => t > now - this.windowMs);
    if (recent.length >= this.limit) {
      return { allowed: false, retryAfterSeconds: Math.ceil(((recent[0] as number) + this.windowMs - now) / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forget a key (e.g. after a successful login so honest users are not penalised for earlier typos). */
  reset(key: string): void {
    this.hits.delete(key);
  }

  private evict(): void {
    while (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next().value;
      if (oldest === undefined) return;
      this.hits.delete(oldest);
    }
  }

  get size(): number {
    return this.hits.size;
  }
}
