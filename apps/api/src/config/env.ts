import { z } from "zod";
import { redactUrl } from "./redact";
import { Secret } from "./secret";

/** Thrown when the environment is invalid. Messages never contain the offending values. */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/**
 * Strict boolean parsing for environment variables.
 *
 * The reference project used `z.coerce.boolean()`, which is `Boolean(string)`: every non-empty
 * string, including "false" and "0", became `true`. That silently enabled `trust proxy` while the
 * .env said TRUST_PROXY=false. Here anything that is not clearly true or false is an error.
 */
export function parseEnvBoolean(value: string): boolean | undefined {
  const normalised = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalised)) return true;
  if (["false", "0", "no", "off"].includes(normalised)) return false;
  return undefined;
}

const envInt = (min: number, max: number) =>
  z
    .string()
    .regex(/^-?\d+$/, "must be an integer")
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

function urlWithProtocols(protocols: readonly string[], requirePath: boolean) {
  return (value: string, ctx: z.RefinementCtx): void => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be a valid URL" });
      return;
    }
    if (!protocols.includes(parsed.protocol)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must use one of: ${protocols.join(", ")}` });
    }
    if (!parsed.hostname) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must include a host" });
    }
    if (requirePath && parsed.pathname.length <= 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must include a database name" });
    }
  };
}

const logLevels = ["debug", "info", "warn", "error"] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  API_HOST: z.string().min(1).max(255).optional(),
  API_PORT: envInt(1, 65535).optional(),
  DATABASE_URL: z.string().superRefine(urlWithProtocols(["postgres:", "postgresql:"], true)),
  // Optional: nothing in the API connects to Redis (the job queue and real-time layer use PostgreSQL only). It is still
  // validated when present, so a typo is reported instead of silently ignored.
  REDIS_URL: z.string().superRefine(urlWithProtocols(["redis:", "rediss:"], false)).optional(),
  TRUST_PROXY: z.string().optional(),
  TRUST_PROXY_HOPS: envInt(0, 10).optional(),
  CORS_ORIGINS: z.string().optional(),
  BODY_LIMIT_BYTES: envInt(1024, 10 * 1024 * 1024).optional(),
  WEBHOOK_BODY_LIMIT_BYTES: envInt(1024, 10 * 1024 * 1024).optional(),
  DB_POOL_MAX: envInt(1, 100).optional(),
  DB_CONNECT_TIMEOUT_MS: envInt(100, 60_000).optional(),
  DB_STATEMENT_TIMEOUT_MS: envInt(100, 300_000).optional(),
  SESSION_TTL_HOURS: envInt(1, 24 * 90).optional(),
  INVITE_TTL_HOURS: envInt(1, 24 * 30).optional(),
  MIGRATE_ON_START: z.enum(["apply", "check", "off"]).optional(),
  LOG_LEVEL: z.enum(logLevels).optional(),
  AI_MODEL: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:-]+$/, "must be a model name").optional(),
  AI_TIMEOUT_MS: envInt(1_000, 120_000).optional(),
  AI_PROVIDER: z.enum(["none", "openai", "gemini"]).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  REALTIME_ENABLED: z.string().optional(),
  REALTIME_REVALIDATE_SECONDS: envInt(1, 300).optional(),
});

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = (typeof logLevels)[number];
export type MigrateOnStart = "apply" | "check" | "off";

export interface AiConfig {
  provider: "none" | "openai" | "gemini";
  /** False means AI features are unavailable; core incident management is unaffected. */
  enabled: boolean;
  disabledReason?: string;
  apiKey?: Secret;
  /** Model name sent to the provider. Configurable because model availability changes; not verified against the live API. */
  model: string;
  timeoutMs: number;
}

export interface AppConfig {
  nodeEnv: NodeEnv;
  http: {
    host: string;
    port: number;
    trustProxyHops: number;
    corsOrigins: string[];
    bodyLimitBytes: number;
    /** Own limit for server-to-server webhooks (Alertmanager notifications are larger than browser requests). */
    webhookBodyLimitBytes: number;
  };
  auth: { sessionTtlSeconds: number; inviteTtlSeconds: number };
  database: { url: Secret; poolMax: number; connectTimeoutMs: number; statementTimeoutMs: number };
  /** null when REDIS_URL is not set (the normal case). Reserved: no code reads it today. */
  redis: { url: Secret } | null;
  migrations: { mode: MigrateOnStart };
  logLevel: LogLevel;
  ai: AiConfig;
  realtime: {
    /** Socket.IO push updates. Everything works without them (clients keep using the REST API). */
    enabled: boolean;
    /** How often live connections are re-checked against the database (bounds how long a revoked session keeps receiving pushes). */
    revalidateSeconds: number;
  };
}

type RawEnv = Record<string, string | undefined>;

/** Blank values count as unset (`set FOO=` on Windows, `FOO=` in dotenv files). */
function dropBlank(raw: RawEnv): Record<string, string> {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value !== undefined && value.trim() !== "") cleaned[key] = value;
  }
  return cleaned;
}

function describeIssue(issue: z.ZodIssue): string {
  const name = issue.path.join(".") || "(root)";
  if (issue.code === z.ZodIssueCode.invalid_type && issue.received === "undefined") {
    return `${name}: is required`;
  }
  // Never echo the received value: it may be a secret.
  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return `${name}: must be one of: ${issue.options.join(", ")}`;
  }
  return `${name}: ${issue.message}`;
}

function parseCorsOrigins(raw: string | undefined, nodeEnv: NodeEnv, problems: string[]): string[] {
  if (!raw) return [];
  const origins: string[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      problems.push("CORS_ORIGINS: contains an entry that is not a valid origin (wildcards are not allowed)");
      continue;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      problems.push("CORS_ORIGINS: origins must use http or https");
      continue;
    }
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      problems.push("CORS_ORIGINS: entries must be bare origins (scheme://host[:port]) with no credentials or path");
      continue;
    }
    const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (nodeEnv === "production" && parsed.protocol === "http:" && !isLocal) {
      problems.push("CORS_ORIGINS: production origins must use https (http is only allowed for localhost)");
      continue;
    }
    origins.push(parsed.origin);
  }
  return [...new Set(origins)];
}

function resolveAi(env: z.infer<typeof envSchema>): AiConfig {
  const provider = env.AI_PROVIDER ?? "none";
  const model = env.AI_MODEL ?? "gpt-5-mini";
  const timeoutMs = env.AI_TIMEOUT_MS ?? 30_000;
  if (provider === "none") {
    return { provider, enabled: false, disabledReason: "AI_PROVIDER is none", model, timeoutMs };
  }
  // A missing key must NOT stop the server: AI is an enhancement, not a dependency of incident tracking.
  const key = provider === "openai" ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!key) {
    const name = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    return { provider, enabled: false, disabledReason: `${name} is not set`, model, timeoutMs };
  }
  if (provider === "gemini") {
    // Gemini is accepted for an explicit, non-fatal configuration, but no adapter exists yet.
    // Do not report AI as enabled when the provider factory will return null.
    return { provider, enabled: false, disabledReason: "Gemini provider is not implemented", model, timeoutMs };
  }
  return { provider, enabled: true, apiKey: new Secret(key), model, timeoutMs };
}

/** Validates the environment and returns typed configuration, or throws ConfigError listing every problem. */
export function loadConfig(raw: RawEnv = process.env): AppConfig {
  const source = dropBlank(raw);
  const problems: string[] = [];

  const result = envSchema.safeParse(source);
  if (!result.success) problems.push(...result.error.issues.map(describeIssue));

  // Legacy boolean TRUST_PROXY from the reference project: parse it correctly, then refuse the
  // dangerous meaning. `false` is accepted (and has no effect); `true` is rejected.
  if (source.TRUST_PROXY !== undefined) {
    const legacy = parseEnvBoolean(source.TRUST_PROXY);
    if (legacy === undefined) {
      problems.push("TRUST_PROXY: must be true/false; note it is deprecated, use TRUST_PROXY_HOPS");
    } else if (legacy) {
      problems.push(
        "TRUST_PROXY: `true` is no longer supported because it trusts every client-supplied X-Forwarded-For header. " +
          "Set TRUST_PROXY_HOPS to the number of reverse proxies in front of the API instead.",
      );
    }
  }

  let realtimeEnabled = true;
  if (source.REALTIME_ENABLED !== undefined) {
    const parsed = parseEnvBoolean(source.REALTIME_ENABLED);
    if (parsed === undefined) problems.push("REALTIME_ENABLED: must be true or false");
    else realtimeEnabled = parsed;
  }

  const nodeEnv: NodeEnv = result.success ? (result.data.NODE_ENV ?? "development") : "development";
  const corsOrigins = parseCorsOrigins(source.CORS_ORIGINS, nodeEnv, problems);

  if (!result.success || problems.length > 0) throw new ConfigError(problems);
  const env = result.data;

  return {
    nodeEnv,
    http: {
      host: env.API_HOST ?? "127.0.0.1",
      port: env.API_PORT ?? 3001,
      trustProxyHops: env.TRUST_PROXY_HOPS ?? 0,
      corsOrigins,
      bodyLimitBytes: env.BODY_LIMIT_BYTES ?? 64 * 1024,
      webhookBodyLimitBytes: env.WEBHOOK_BODY_LIMIT_BYTES ?? 1024 * 1024,
    },
    auth: {
      sessionTtlSeconds: (env.SESSION_TTL_HOURS ?? 24 * 7) * 3600,
      inviteTtlSeconds: (env.INVITE_TTL_HOURS ?? 24 * 7) * 3600,
    },
    database: {
      url: new Secret(env.DATABASE_URL),
      poolMax: env.DB_POOL_MAX ?? 10,
      connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS ?? 5_000,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS ?? 15_000,
    },
    redis: env.REDIS_URL ? { url: new Secret(env.REDIS_URL) } : null,
    migrations: { mode: env.MIGRATE_ON_START ?? "check" },
    logLevel: env.LOG_LEVEL ?? "info",
    ai: resolveAi(env),
    realtime: { enabled: realtimeEnabled, revalidateSeconds: env.REALTIME_REVALIDATE_SECONDS ?? 10 },
  };
}

/** A log-safe summary of the configuration: connection passwords and API keys are masked. */
export function describeConfig(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    http: config.http,
    auth: config.auth,
    database: {
      url: redactUrl(config.database.url.reveal()),
      poolMax: config.database.poolMax,
      connectTimeoutMs: config.database.connectTimeoutMs,
      statementTimeoutMs: config.database.statementTimeoutMs,
    },
    redis: config.redis ? { url: redactUrl(config.redis.url.reveal()) } : null,
    migrations: config.migrations,
    logLevel: config.logLevel,
    ai: { provider: config.ai.provider, enabled: config.ai.enabled, disabledReason: config.ai.disabledReason, model: config.ai.model, timeoutMs: config.ai.timeoutMs },
    realtime: config.realtime,
  };
}
