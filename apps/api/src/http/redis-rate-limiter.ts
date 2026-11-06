import { createHash, randomUUID } from "node:crypto";
import type { RedisClientType } from "redis";
import { RateLimiterUnavailableError, type RateLimiter, type RateLimitResult } from "./rate-limiter";

const KEY_PREFIX = "iip:rate-limit:v1";
/** Absolute wall-clock cap for an EVAL after it has been dispatched to Redis. */
export const REDIS_COMMAND_DEADLINE_MS = 5_000;

/** Stable policy names are part of the Redis key to prevent one policy mutating another policy's window. */
export type RateLimitPolicy =
  | "login-ip"
  | "login-account"
  | "register-ip"
  | "alertmanager-ip"
  | "webhook-failed-auth"
  | "alertmanager-integration"
  | "ai-user";

const CONSUME_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local requestId = ARGV[3]
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local windowStart = now - windowMs

redis.call("ZREMRANGEBYSCORE", key, "-inf", windowStart)
local count = redis.call("ZCARD", key)

if count >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retryAfter = 1
  if #oldest > 0 then
    retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + windowMs - now) / 1000))
  end
  local latest = redis.call("ZREVRANGE", key, 0, 0, "WITHSCORES")
  if #latest > 0 then
    redis.call("PEXPIRE", key, math.max(1, tonumber(latest[2]) + windowMs - now))
  end
  return {0, retryAfter}
end

redis.call("ZADD", key, now, requestId)
redis.call("PEXPIRE", key, windowMs)
return {1, 0}
`;

const PEEK_SCRIPT = `
local key = KEYS[1]
local windowMs = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local time = redis.call("TIME")
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local windowStart = now - windowMs

redis.call("ZREMRANGEBYSCORE", key, "-inf", windowStart)
local count = redis.call("ZCARD", key)

if count >= limit then
  local oldest = redis.call("ZRANGE", key, 0, 0, "WITHSCORES")
  local retryAfter = 1
  if #oldest > 0 then
    retryAfter = math.max(1, math.ceil((tonumber(oldest[2]) + windowMs - now) / 1000))
  end
  local latest = redis.call("ZREVRANGE", key, 0, 0, "WITHSCORES")
  if #latest > 0 then
    redis.call("PEXPIRE", key, math.max(1, tonumber(latest[2]) + windowMs - now))
  end
  return {0, retryAfter}
end

if count > 0 then
  local latest = redis.call("ZREVRANGE", key, 0, 0, "WITHSCORES")
  if #latest > 0 then
    redis.call("PEXPIRE", key, math.max(1, tonumber(latest[2]) + windowMs - now))
  end
end
return {1, 0}
`;

const RESET_SCRIPT = `
return redis.call("DEL", KEYS[1])
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly getClient: () => Promise<RedisClientType | null>,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly policy: RateLimitPolicy,
    private readonly keyPrefix = KEY_PREFIX,
    private readonly retireTimedOutClient: (client: RedisClientType) => void = (client) => client.destroy(),
    private readonly commandDeadlineMs = REDIS_COMMAND_DEADLINE_MS,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new RangeError("windowMs must be a positive integer");
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(policy)) throw new TypeError("invalid rate-limit policy namespace");
    if (!Number.isInteger(commandDeadlineMs) || commandDeadlineMs < 1) throw new RangeError("commandDeadlineMs must be a positive integer");
  }

  async consume(identity: string): Promise<RateLimitResult> {
    const client = await this.requireClient();
    const result = await this.eval(client, CONSUME_SCRIPT, {
      keys: [this.key(identity)],
      arguments: [String(this.windowMs), String(this.limit), randomUUID()],
    });
    return this.parseResult(result);
  }

  async peek(identity: string): Promise<RateLimitResult> {
    const client = await this.requireClient();
    const result = await this.eval(client, PEEK_SCRIPT, {
      keys: [this.key(identity)],
      arguments: [String(this.windowMs), String(this.limit)],
    });
    return this.parseResult(result);
  }

  async reset(identity: string): Promise<void> {
    const client = await this.requireClient();
    await this.eval(client, RESET_SCRIPT, { keys: [this.key(identity)], arguments: [] });
  }

  private async eval(
    client: RedisClientType,
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown> {
    const command = client.eval(script, options);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Reject first, then retire the actual socket so the losing command promise is also aborted.
        reject(new RateLimiterUnavailableError());
        try {
          this.retireTimedOutClient(client);
        } catch {
          try {
            client.destroy();
          } catch {
            // Client may have been destroyed by a concurrent disconnect.
          }
        }
      }, this.commandDeadlineMs);
    });
    try {
      return await Promise.race([command, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async requireClient(): Promise<RedisClientType> {
    const client = await this.getClient();
    if (!client || !client.isReady) throw new RateLimiterUnavailableError();
    return client;
  }

  private key(identity: string): string {
    const identityHash = createHash("sha256").update(identity, "utf8").digest("hex");
    return `${this.keyPrefix}:${this.policy}:${identityHash}`;
  }

  private parseResult(result: unknown): RateLimitResult {
    if (!Array.isArray(result) || result.length !== 2) throw new RateLimiterUnavailableError();
    const allowed = Number(result[0]) === 1;
    const retryAfterSeconds = Number(result[1]);
    if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) throw new RateLimiterUnavailableError();
    return { allowed, retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(retryAfterSeconds)) };
  }
}

export type RedisLimiterFailurePolicy = "fail-open" | "fail-closed";

export class ResilientRedisRateLimiter implements RateLimiter {
  private lastFailureLogAt = 0;

  constructor(
    private readonly redis: RateLimiter,
    private readonly memory: RateLimiter,
    private readonly failurePolicy: RedisLimiterFailurePolicy,
    private readonly failClosedRetryAfterSeconds = 60,
    private readonly onBackendFailure?: (operation: "consume" | "peek" | "reset") => void,
  ) {}

  async consume(identity: string): Promise<RateLimitResult> {
    try {
      return await this.redis.consume(identity);
    } catch {
      this.warnOnce("consume");
      return this.onFailure(() => this.memory.consume(identity));
    }
  }

  async peek(identity: string): Promise<RateLimitResult> {
    try {
      return await this.redis.peek(identity);
    } catch {
      this.warnOnce("peek");
      return this.onFailure(() => this.memory.peek(identity));
    }
  }

  /**
   * An availability-aware preflight for credential gates. It intentionally propagates a sanitized failure so a caller
   * can defer the decision until it knows whether the request is authenticated. Invalid credentials still call consume(),
   * which remains fail-closed; valid Alertmanager deliveries are not rejected solely because this preflight is unavailable.
   */
  async peekStrict(identity: string): Promise<RateLimitResult> {
    try {
      return await this.redis.peek(identity);
    } catch {
      this.warnOnce("peek");
      throw new RateLimiterUnavailableError();
    }
  }

  async reset(identity: string): Promise<void> {
    try {
      await this.redis.reset(identity);
      await this.memory.reset(identity);
    } catch {
      this.warnOnce("reset");
      if (this.failurePolicy === "fail-closed") throw new RateLimiterUnavailableError();
      await this.memory.reset(identity);
    }
  }

  private async onFailure(fallback: () => Promise<RateLimitResult>): Promise<RateLimitResult> {
    if (this.failurePolicy === "fail-open") return fallback();
    return { allowed: false, retryAfterSeconds: this.failClosedRetryAfterSeconds };
  }

  private warnOnce(operation: "consume" | "peek" | "reset"): void {
    const now = Date.now();
    if (now - this.lastFailureLogAt < 30_000) return;
    this.lastFailureLogAt = now;
    this.onBackendFailure?.(operation);
  }
}
