import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { createClient, type RedisClientType } from "redis";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/env";
import { createLogger } from "../common/logger";

/** Keep each rate-limit backend operation bounded; failure policy is applied by ResilientRedisRateLimiter. */
export const REDIS_CONNECT_TIMEOUT_MS = 1_000;
/** Absolute deadline for the full Redis handshake, not only the TCP connect phase. */
export const REDIS_CONNECT_DEADLINE_MS = 5_000;
export const REDIS_COMMAND_TIMEOUT_MS = 1_000;
export const REDIS_RETRY_COOLDOWN_MS = 1_000;


/**
 * Bound the complete node-redis connect/HELLO handshake. `socket.connectTimeout` only bounds the TCP connection phase;
 * this watchdog destroys the client as well as rejecting so the underlying connect operation cannot keep running.
 */
export async function connectRedisClientWithDeadline(
  client: RedisClientType,
  timeoutMs = REDIS_CONNECT_DEADLINE_MS,
): Promise<void> {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new RangeError("timeoutMs must be a positive integer");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connecting = client.connect().then(() => undefined);
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Destroying the socket aborts the underlying connection attempt; Promise.race alone would leak it.
      try {
        client.destroy();
      } catch {
        // The client may already have closed itself while the deadline callback was queued.
      }
      reject(new Error("Redis connection deadline exceeded"));
    }, timeoutMs);
  });
  try {
    await Promise.race([connecting, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

@Injectable()
export class RedisConnectionProvider implements OnApplicationShutdown {
  private client: RedisClientType | null = null;
  private connectingClient: RedisClientType | null = null;
  private connectPromise: Promise<RedisClientType | null> | null = null;
  private shuttingDown = false;
  private retryConnectAt = 0;
  private lastWarningAt = 0;
  private readonly log: ReturnType<typeof createLogger>;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.log = createLogger(config.logLevel);
  }

  isConfigured(): boolean {
    return this.config.redis !== null;
  }

  async getClient(): Promise<RedisClientType | null> {
    const redisConfig = this.config.redis;
    if (!redisConfig || this.shuttingDown) return null;
    if (this.client?.isReady) return this.client;
    if (this.connectPromise) return this.connectPromise;
    if (Date.now() < this.retryConnectAt) return null;

    // A client that lost its connection with reconnectStrategy=false is terminal; release it before replacement.
    if (this.client) {
      this.client.destroy();
      this.client = null;
    }

    const client = createClient({
      url: redisConfig.url.reveal(),
      disableOfflineQueue: true,
      commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
      socket: {
        connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
        // Fail this client on disconnect. The next HTTP request creates a fresh client, which also enables recovery.
        reconnectStrategy: () => false,
      },
    });
    client.on("error", (error: unknown) => this.warn("connection", error));
    // node-redis 6.3.x can still be waiting for its TCP connect event when destroy()
    // is first called. In that state its internal RedisSocket has not assigned the
    // net.Socket yet, so the first destroy cannot reach it. Re-check at the public
    // "connect" event (emitted after the socket is assigned and before HELLO) and
    // force-destroy again if application shutdown has started.
    client.once("connect", () => {
      if (this.shuttingDown) {
        try {
          client.destroy();
        } catch {
          // Shutdown is best-effort; node-redis may already have closed the socket.
        }
      }
    });
    this.connectingClient = client;

    const attempt = (async (): Promise<RedisClientType | null> => {
      try {
        await connectRedisClientWithDeadline(client);
        if (this.shuttingDown || !client.isReady) {
          client.destroy();
          return null;
        }
        this.client = client;
        this.retryConnectAt = 0;
        return client;
      } catch (error) {
        this.warn("connect", error);
        this.retryConnectAt = Date.now() + REDIS_RETRY_COOLDOWN_MS;
        client.destroy();
        return null;
      } finally {
        if (this.connectingClient === client) this.connectingClient = null;
        this.connectPromise = null;
      }
    })();
    this.connectPromise = attempt;
    return attempt;
  }

  /** Retire a client whose in-flight command exceeded its hard deadline; subsequent calls reconnect after cooldown. */
  retireClient(client: RedisClientType): void {
    if (this.client === client) {
      this.client = null;
      this.retryConnectAt = Date.now() + REDIS_RETRY_COOLDOWN_MS;
    }
    try {
      client.destroy();
    } catch {
      // A concurrent socket close or shutdown may already have destroyed this client.
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    this.retryConnectAt = Number.MAX_SAFE_INTEGER;
    const pending = this.connectingClient;
    const connected = this.client;
    this.connectingClient = null;
    this.client = null;

    // destroy() aborts an active socket/connect without leaving a retry loop or an offline command queue.
    pending?.destroy();
    if (connected && connected !== pending) connected.destroy();
    await this.connectPromise?.catch(() => null);
  }

  private warn(category: string, error: unknown): void {
    const now = Date.now();
    if (now - this.lastWarningAt < 30_000) return;
    this.lastWarningAt = now;
    const rawCode = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "UNKNOWN";
    const code = /^[A-Za-z0-9_]{1,48}$/.test(rawCode) ? rawCode : "UNKNOWN";
    this.log.warn("redis rate-limit backend unavailable", { category, code });
  }
}
