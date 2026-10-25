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
      ctx.addIssue({ code: "custom", message: "must be a valid URL" });
      return;
    }
    if (!protocols.includes(parsed.protocol)) {
      ctx.addIssue({ code: "custom", message: `must use one of: ${protocols.join(", ")}` });
    }
    if (!parsed.hostname) {
      ctx.addIssue({ code: "custom", message: "must include a host" });
    }
    if (requirePath && parsed.pathname.length <= 1) {
      ctx.addIssue({ code: "custom", message: "must include a database name" });
    }
  };
}

const logLevels = ["debug", "info", "warn", "error"] as const;

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
  API_HOST: z.string().min(1).max(255).optional(),
  API_PORT: envInt(1, 65535).optional(),
  DATABASE_URL: z.string().superRefine(urlWithProtocols(["postgres:", "postgresql:"], true)),
  // Optional dedicated session connection for LISTEN/NOTIFY; defaults to DATABASE_URL.
  REALTIME_DATABASE_URL: z.string().superRefine(urlWithProtocols(["postgres:", "postgresql:"], true)).optional(),
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
  // "fake" is a deterministic, keyless provider for LOCAL use and tests; it is refused when NODE_ENV=production.
  AI_PROVIDER: z.enum(["none", "openai", "gemini", "fake"]).optional(),
  // Global switch for grounded AI suggestions (Milestone 9). Default OFF; a provider and a key are also required.
  AI_ENABLED: z.string().optional(),
  // Requests per organization per UTC day (atomic in PostgreSQL). Each request is one logical suggestion, retries are free.
  AI_DAILY_REQUEST_LIMIT: envInt(1, 1000).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  REALTIME_ENABLED: z.string().optional(),
  REALTIME_REVALIDATE_SECONDS: envInt(1, 300).optional(),
  PUBLIC_REGISTRATION_ENABLED: z.string().optional(),
});

export type NodeEnv = "development" | "test" | "production";
export type LogLevel = (typeof logLevels)[number];
export type MigrateOnStart = "apply" | "check" | "off";

/** Grounded AI suggestions (Milestone 9). Separate from the older per-incident analysis, which is controlled by AI_PROVIDER alone. */
export interface AiSuggestionsConfig {
  /** True only when AI_ENABLED is true AND a usable provider exists. Everything else about the feature is gated on this. */
  enabled: boolean;
  disabledReason?: string;
  dailyRequestLimit: number;
}

export interface AiConfig {
  provider: "none" | "openai" | "gemini" | "fake";
  /** False means AI features are unavailable; core incident management is unaffected. */
  enabled: boolean;
  disabledReason?: string;
  apiKey?: Secret;
  /** Model name sent to the provider. Configurable because model availability changes; not verified against the live API. */
  model: string;
  timeoutMs: number;
  suggestions: AiSuggestionsConfig;
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
  auth: { sessionTtlSeconds: number; inviteTtlSeconds: number; publicRegistrationEnabled: boolean };
  database: { url: Secret; realtimeUrl?: Secret; poolMax: number; connectTimeoutMs: number; statementTimeoutMs: number };
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

function describeIssue(issue: z.ZodIssue, source: Record<string, string>): string {
  const name = issue.path.join(".") || "(root)";
  // Required environment fields are top-level keys. Do not rely on Zod's optional
  // reported-input field (which is omitted by default in Zod 4) to identify absence.
  const key = issue.path.length === 1 ? String(issue.path[0]) : undefined;
  if (issue.code === "invalid_type" && key !== undefined && source[key] === undefined) {
    return `${name}: is required`;
  }
  // Zod 4 reports enum/literal failures as `invalid_value` with a `values` array.
  // Only disclose the allowed choices, never the rejected value.
  if (issue.code === "invalid_value" && "values" in issue && Array.isArray(issue.values) && issue.values.every((value) => typeof value === "string")) {
    return `${name}: must be one of: ${issue.values.join(", ")}`;
  }
  return `${name}: ${issue.message}`;
}

/**
 * Best-effort rejection of common PostgreSQL pooler endpoints for LISTEN/NOTIFY. This is a guardrail,
 * not proof that a server is direct; the deployment owner must supply the provider's direct connection URL.
 * The URL is never returned in diagnostics because it contains credentials.
 */
export function pooledListenerProblem(effectiveUrl: string | undefined, explicit: boolean): string | undefined {
  if (!explicit) return "REALTIME_DATABASE_URL: set a dedicated direct PostgreSQL endpoint when REALTIME_ENABLED=true";
  if (!effectiveUrl) return "REALTIME_DATABASE_URL: required when REALTIME_ENABLED=true";
  try {
    const url = new URL(effectiveUrl);
    const pooledHost = /(^|[-.])pooler([-.]|$)/i.test(url.hostname);
    const pooledPort = url.port === "6432";
    if (pooledHost || pooledPort) return "REALTIME_DATABASE_URL: must use a direct PostgreSQL endpoint, not a pooled/pooler endpoint";
  } catch {
    // The schema reports malformed URLs separately without including secret values.
  }
  return undefined;
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

function resolveAi(env: z.infer<typeof envSchema>, suggestionsSwitch: boolean): AiConfig {
  const provider = env.AI_PROVIDER ?? "none";
  const model = env.AI_MODEL ?? "gpt-5-mini";
  const timeoutMs = env.AI_TIMEOUT_MS ?? 30_000;
  const dailyRequestLimit = env.AI_DAILY_REQUEST_LIMIT ?? 20;
  const off = (reason: string) => ({ enabled: false, disabledReason: reason, dailyRequestLimit });
  // The switch comes first: with AI_ENABLED unset (the default) suggestions are off whatever else is configured.
  const gate = (reason: string | null, ready: boolean): AiSuggestionsConfig =>
    !suggestionsSwitch ? off("AI_ENABLED is not true") : reason ? off(reason) : { enabled: ready, dailyRequestLimit };

  if (provider === "none") {
    return { provider, enabled: false, disabledReason: "AI_PROVIDER is none", model, timeoutMs, suggestions: gate("AI_PROVIDER is none", false) };
  }
  if (provider === "fake") {
    // Keyless and deterministic: suggestions only. The older analysis feature needs a real provider and stays off.
    return { provider, enabled: false, disabledReason: "AI_PROVIDER is fake (grounded suggestions only)", model, timeoutMs, suggestions: gate(null, true) };
  }
  // A missing key must NOT stop the server: AI is an enhancement, not a dependency of incident tracking.
  const key = provider === "openai" ? env.OPENAI_API_KEY : env.GEMINI_API_KEY;
  if (!key) {
    const name = provider === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY";
    return { provider, enabled: false, disabledReason: `${name} is not set`, model, timeoutMs, suggestions: gate(`${name} is not set`, false) };
  }
  if (provider === "gemini") {
    // Gemini is accepted for an explicit, non-fatal configuration, but no adapter exists yet.
    // Do not report AI as enabled when the provider factory will return null.
    return { provider, enabled: false, disabledReason: "Gemini provider is not implemented", model, timeoutMs, suggestions: gate("Gemini provider is not implemented", false) };
  }
  return { provider, enabled: true, apiKey: new Secret(key), model, timeoutMs, suggestions: gate(null, true) };
}

/** Validates the environment and returns typed configuration, or throws ConfigError listing every problem. */
export function loadConfig(raw: RawEnv = process.env): AppConfig {
  const source = dropBlank(raw);
  const problems: string[] = [];

  const result = envSchema.safeParse(source);
  if (!result.success) problems.push(...result.error.issues.map((issue) => describeIssue(issue, source)));

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

  let suggestionsSwitch = false;
  if (source.AI_ENABLED !== undefined) {
    const parsed = parseEnvBoolean(source.AI_ENABLED);
    if (parsed === undefined) problems.push("AI_ENABLED: must be true or false");
    else suggestionsSwitch = parsed;
  }

  let realtimeEnabled = false;
  if (source.REALTIME_ENABLED !== undefined) {
    const parsed = parseEnvBoolean(source.REALTIME_ENABLED);
    if (parsed === undefined) problems.push("REALTIME_ENABLED: must be true or false");
    else realtimeEnabled = parsed;
  }

  let publicRegistrationEnabled: boolean | undefined;
  if (source.PUBLIC_REGISTRATION_ENABLED !== undefined) {
    const parsed = parseEnvBoolean(source.PUBLIC_REGISTRATION_ENABLED);
    if (parsed === undefined) problems.push("PUBLIC_REGISTRATION_ENABLED: must be true or false");
    else publicRegistrationEnabled = parsed;
  }

  const nodeEnv: NodeEnv = result.success ? (result.data.NODE_ENV ?? "development") : "development";
  const corsOrigins = parseCorsOrigins(source.CORS_ORIGINS, nodeEnv, problems);
  if (realtimeEnabled) {
    const realtimeProblem = pooledListenerProblem(source.REALTIME_DATABASE_URL, source.REALTIME_DATABASE_URL !== undefined);
    if (realtimeProblem) problems.push(realtimeProblem);
  }
  if (nodeEnv === "production" && source.AI_PROVIDER === "fake") {
    problems.push("AI_PROVIDER: fake is for local use and tests only and is not allowed when NODE_ENV=production");
  }

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
      publicRegistrationEnabled: publicRegistrationEnabled ?? nodeEnv !== "production",
    },
    database: {
      url: new Secret(env.DATABASE_URL),
      realtimeUrl: env.REALTIME_DATABASE_URL ? new Secret(env.REALTIME_DATABASE_URL) : undefined,
      poolMax: env.DB_POOL_MAX ?? 10,
      connectTimeoutMs: env.DB_CONNECT_TIMEOUT_MS ?? 5_000,
      statementTimeoutMs: env.DB_STATEMENT_TIMEOUT_MS ?? 15_000,
    },
    redis: env.REDIS_URL ? { url: new Secret(env.REDIS_URL) } : null,
    migrations: { mode: env.MIGRATE_ON_START ?? "check" },
    logLevel: env.LOG_LEVEL ?? "info",
    ai: resolveAi(env, suggestionsSwitch),
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
      realtimeUrl: config.database.realtimeUrl ? redactUrl(config.database.realtimeUrl.reveal()) : null,
      poolMax: config.database.poolMax,
      connectTimeoutMs: config.database.connectTimeoutMs,
      statementTimeoutMs: config.database.statementTimeoutMs,
    },
    redis: config.redis ? { url: redactUrl(config.redis.url.reveal()) } : null,
    migrations: config.migrations,
    logLevel: config.logLevel,
    ai: {
      provider: config.ai.provider,
      enabled: config.ai.enabled,
      disabledReason: config.ai.disabledReason,
      model: config.ai.model,
      timeoutMs: config.ai.timeoutMs,
      suggestions: config.ai.suggestions,
    },
    realtime: config.realtime,
  };
}
