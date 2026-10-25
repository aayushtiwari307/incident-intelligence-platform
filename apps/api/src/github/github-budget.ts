/**
 * Outbound call budget for the GitHub client (Stage 3 design). Two independent controls, both pure and clock-injected:
 *
 *  - GitHubBudget: ONE budget per process for the shared GitHub quota. It learns the real remaining quota from GitHub's
 *    own X-RateLimit-* headers, honours Retry-After, and opens a circuit breaker after repeated failures so a GitHub
 *    outage costs at most a few slow calls instead of a request pile-up. The unauthenticated limit is small, so this is
 *    the control that actually protects the free quota; per-organization buckets only share it out fairly.
 *  - KeyedTokenBucket: fair per-key (organization) rate limiting with a bounded key table.
 *
 * Neither logs anything or reads the clock itself; callers pass `nowMs`. Per-process only, like the existing in-memory
 * limiters: it is not shared across API instances.
 */

export interface HeaderReader {
  get(name: string): string | null;
}

export type BudgetDecision =
  | { ok: true }
  | { ok: false; reason: "rate_limited" | "circuit_open"; retryAfterMs: number };

export interface GitHubBudgetOptions {
  /** Calls to keep in hand: stop when GitHub reports this many or fewer remaining. */
  reserve: number;
  /** Consecutive failures (5xx, timeout, network) that open the circuit breaker. */
  failureThreshold: number;
  breakerMs: number;
  /** Upper bound for any single block, so a bad header can never disable the feature for long. */
  maxBlockMs: number;
  /** Lower bound for a block caused by 429 or an exhausted 403 with no usable header. */
  minBlockMs: number;
}

const DEFAULTS: GitHubBudgetOptions = {
  reserve: 5,
  failureThreshold: 3,
  breakerMs: 60_000,
  maxBlockMs: 3_600_000,
  minBlockMs: 60_000,
};

function digits(value: string | null): number | null {
  if (value === null || !/^[0-9]{1,12}$/.test(value.trim())) return null;
  return Number(value.trim());
}

export class GitHubBudget {
  private readonly opts: GitHubBudgetOptions;
  private remaining: number | null = null;
  private resetAtMs = 0;
  private blockedUntilMs = 0;
  private breakerUntilMs = 0;
  private consecutiveFailures = 0;

  constructor(options: Partial<GitHubBudgetOptions> = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  /** Checks the budget WITHOUT consuming it. */
  check(nowMs: number): BudgetDecision {
    if (nowMs < this.blockedUntilMs) return { ok: false, reason: "rate_limited", retryAfterMs: this.blockedUntilMs - nowMs };
    if (nowMs < this.breakerUntilMs) return { ok: false, reason: "circuit_open", retryAfterMs: this.breakerUntilMs - nowMs };
    if (this.remaining !== null && this.remaining <= this.opts.reserve && nowMs < this.resetAtMs) {
      return { ok: false, reason: "rate_limited", retryAfterMs: this.resetAtMs - nowMs };
    }
    return { ok: true };
  }

  /** Checks and, when allowed, optimistically uses one call so concurrent callers cannot all pass on the same quota. */
  tryAcquire(nowMs: number): BudgetDecision {
    const decision = this.check(nowMs);
    if (decision.ok && this.remaining !== null) this.remaining -= 1;
    return decision;
  }

  /**
   * Records a finished call. `status` is the HTTP status, or 0 for a network error or timeout. Headers are the source of
   * truth for the remaining quota and overwrite the optimistic local count.
   */
  record(nowMs: number, status: number, headers: HeaderReader): void {
    const remaining = digits(headers.get("x-ratelimit-remaining"));
    const resetSeconds = digits(headers.get("x-ratelimit-reset"));
    const retryAfterSeconds = digits(headers.get("retry-after"));
    if (remaining !== null) this.remaining = remaining;
    if (resetSeconds !== null) this.resetAtMs = resetSeconds * 1000;

    const exhausted = status === 429 || (status === 403 && (remaining === 0 || retryAfterSeconds !== null));
    if (exhausted) {
      const untilReset = this.resetAtMs > nowMs ? this.resetAtMs - nowMs : 0;
      const requested = Math.max(retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 0, untilReset, this.opts.minBlockMs);
      this.blockedUntilMs = nowMs + Math.min(requested, this.opts.maxBlockMs);
      return; // being rate limited is not an outage: it does not feed the circuit breaker
    }
    // If GitHub says we are at/below the reserve but omits a usable reset header, pause briefly and then
    // permit one probe. This avoids both spending the last calls and blocking forever on malformed/missing metadata.
    if (remaining !== null && remaining <= this.opts.reserve && this.resetAtMs <= nowMs) {
      this.blockedUntilMs = nowMs + this.opts.minBlockMs;
      return;
    }
    if (status === 0 || status >= 500) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.opts.failureThreshold) {
        this.breakerUntilMs = nowMs + this.opts.breakerMs;
        this.consecutiveFailures = 0;
      }
      return;
    }
    this.consecutiveFailures = 0;
  }
}

export interface BucketOptions {
  capacity: number;
  /** Tokens added per millisecond (for example 30 per 10 minutes = 30 / 600_000). */
  refillPerMs: number;
  maxKeys?: number;
}

export type BucketDecision = { ok: true } | { ok: false; retryAfterMs: number };

export class KeyedTokenBucket {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly maxKeys: number;
  private readonly state = new Map<string, { tokens: number; updatedMs: number }>();

  constructor(options: BucketOptions) {
    if (!(options.capacity >= 1) || !(options.refillPerMs > 0)) throw new Error("KeyedTokenBucket: invalid options");
    this.capacity = options.capacity;
    this.refillPerMs = options.refillPerMs;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  tryTake(key: string, nowMs: number): BucketDecision {
    const previous = this.state.get(key);
    let tokens = this.capacity;
    if (previous) {
      const elapsed = Math.max(0, nowMs - previous.updatedMs);
      tokens = Math.min(this.capacity, previous.tokens + elapsed * this.refillPerMs);
      this.state.delete(key); // re-insert below to keep the table in least-recently-used order
    } else if (this.state.size >= this.maxKeys) {
      const oldest = this.state.keys().next().value;
      if (oldest !== undefined) this.state.delete(oldest);
    }
    if (tokens >= 1) {
      this.state.set(key, { tokens: tokens - 1, updatedMs: nowMs });
      return { ok: true };
    }
    this.state.set(key, { tokens, updatedMs: nowMs });
    return { ok: false, retryAfterMs: Math.ceil((1 - tokens) / this.refillPerMs) };
  }

  get size(): number {
    return this.state.size;
  }
}
