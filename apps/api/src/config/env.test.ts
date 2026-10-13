import assert from "node:assert/strict";
import { inspect } from "node:util";
import { ConfigError, describeConfig, loadConfig, parseEnvBoolean } from "./env";

const DB_PASSWORD = "Sup3rS3cretDbPw";
const REDIS_PASSWORD = "Sup3rS3cretRedisPw";

function base(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DATABASE_URL: `postgresql://platform:${DB_PASSWORD}@127.0.0.1:5434/platform`,
    REDIS_URL: `redis://:${REDIS_PASSWORD}@127.0.0.1:6380`,
    ...extra,
  };
}

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError, "expected a ConfigError");
    return [...error.problems];
  }
  assert.fail("expected loadConfig to throw");
}

describe("parseEnvBoolean (regression: reference used z.coerce.boolean)", () => {
  it('treats "false" and "0" as false, unlike Boolean(string)', () => {
    assert.equal(Boolean("false"), true); // the bug we are fixing
    assert.equal(parseEnvBoolean("false"), false);
    assert.equal(parseEnvBoolean("0"), false);
    assert.equal(parseEnvBoolean(" FALSE "), false);
    assert.equal(parseEnvBoolean("no"), false);
    assert.equal(parseEnvBoolean("off"), false);
  });

  it("parses true variants", () => {
    for (const v of ["true", "TRUE", "1", "yes", "on", " true "]) assert.equal(parseEnvBoolean(v), true, v);
  });

  it("returns undefined for anything ambiguous", () => {
    for (const v of ["", "banana", "2", "tru", "null"]) assert.equal(parseEnvBoolean(v), undefined, v);
  });
});

describe("loadConfig defaults", () => {
  it("applies safe defaults from a minimal environment", () => {
    const config = loadConfig(base());
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.http.host, "127.0.0.1"); // loopback by default
    assert.equal(config.http.port, 3001);
    assert.equal(config.http.trustProxyHops, 0);
    assert.deepEqual(config.http.corsOrigins, []);
    assert.equal(config.http.bodyLimitBytes, 65536);
    assert.equal(config.migrations.mode, "check");
    assert.equal(config.logLevel, "info");
    assert.equal(config.database.poolMax, 10);
  });

  it("session and invitation lifetimes default to 7 days and are validated", () => {
    const config = loadConfig(base());
    assert.equal(config.auth.sessionTtlSeconds, 7 * 24 * 3600);
    assert.equal(config.auth.inviteTtlSeconds, 7 * 24 * 3600);
    assert.equal(loadConfig(base({ SESSION_TTL_HOURS: "12" })).auth.sessionTtlSeconds, 12 * 3600);
    assert.throws(() => loadConfig(base({ SESSION_TTL_HOURS: "0" })), /SESSION_TTL_HOURS/);
    assert.throws(() => loadConfig(base({ INVITE_TTL_HOURS: "abc" })), /INVITE_TTL_HOURS/);
  });

  it("treats blank values as unset", () => {
    const config = loadConfig(base({ API_PORT: "", NODE_ENV: "   ", TRUST_PROXY_HOPS: "" }));
    assert.equal(config.http.port, 3001);
    assert.equal(config.nodeEnv, "development");
    assert.equal(config.http.trustProxyHops, 0);
  });

  it("ignores unrelated environment variables", () => {
    assert.doesNotThrow(() => loadConfig(base({ PATH: "/usr/bin", HOME: "/root" })));
  });
});

describe("loadConfig validation", () => {
  it("reports every problem at once and names the variables", () => {
    const problems = problemsOf({ API_PORT: "abc", LOG_LEVEL: "verbose" });
    assert.ok(problems.some((p) => p.startsWith("DATABASE_URL: is required")), problems.join("|"));
    assert.ok(problems.some((p) => p.startsWith("REDIS_URL: is required")));
    assert.ok(problems.some((p) => p.startsWith("API_PORT:")));
    assert.ok(problems.some((p) => p.startsWith("LOG_LEVEL: must be one of")));
  });

  it("rejects out-of-range and non-integer numbers", () => {
    for (const port of ["0", "65536", "-1", "1.5", "abc", "80 80"]) {
      assert.ok(problemsOf(base({ API_PORT: port })).some((p) => p.startsWith("API_PORT:")), port);
    }
    for (const hops of ["-1", "11", "abc", "1.5"]) {
      assert.ok(problemsOf(base({ TRUST_PROXY_HOPS: hops })).some((p) => p.startsWith("TRUST_PROXY_HOPS:")), hops);
    }
  });

  it("rejects malformed connection URLs", () => {
    for (const url of ["not a url", "mysql://u:p@h/db", "postgres://h", "postgres:///db"]) {
      assert.ok(problemsOf(base({ DATABASE_URL: url })).some((p) => p.startsWith("DATABASE_URL:")), url);
    }
    for (const url of ["http://h", "redis://", "nope"]) {
      assert.ok(problemsOf(base({ REDIS_URL: url })).some((p) => p.startsWith("REDIS_URL:")), url);
    }
  });

  it("never echoes secret values in error messages", () => {
    const leaky = `postgres://u:${DB_PASSWORD}@/db`; // empty host -> invalid
    const problems = problemsOf(base({ DATABASE_URL: leaky, NODE_ENV: `${REDIS_PASSWORD}-not-an-env` }));
    const text = problems.join("\n");
    assert.ok(!text.includes(DB_PASSWORD), "database password leaked");
    assert.ok(!text.includes(REDIS_PASSWORD), "enum value echoed");
    assert.ok(text.includes("must be one of: development, test, production"));
  });
});

describe("TRUST_PROXY (reference bug)", () => {
  it('accepts the legacy TRUST_PROXY=false / 0 and does NOT enable trust proxy', () => {
    for (const v of ["false", "0", "FALSE", "no"]) {
      assert.equal(loadConfig(base({ TRUST_PROXY: v })).http.trustProxyHops, 0, v);
    }
  });

  it("rejects TRUST_PROXY=true loudly and points at TRUST_PROXY_HOPS", () => {
    const problems = problemsOf(base({ TRUST_PROXY: "true" }));
    assert.ok(problems.some((p) => p.includes("TRUST_PROXY_HOPS")));
  });

  it("rejects unparseable TRUST_PROXY values", () => {
    assert.ok(problemsOf(base({ TRUST_PROXY: "banana" })).some((p) => p.startsWith("TRUST_PROXY:")));
  });

  it("uses an explicit hop count", () => {
    assert.equal(loadConfig(base({ TRUST_PROXY_HOPS: "2" })).http.trustProxyHops, 2);
  });
});

describe("CORS_ORIGINS", () => {
  it("normalises, trims and de-duplicates origins", () => {
    const config = loadConfig(base({ CORS_ORIGINS: " http://localhost:3000/ , http://localhost:3000,https://app.example.com " }));
    assert.deepEqual(config.http.corsOrigins, ["http://localhost:3000", "https://app.example.com"]);
  });

  it("rejects wildcards, paths, credentials and non-http schemes", () => {
    for (const origin of ["*", "https://app.example.com/path", "https://u:p@app.example.com", "ftp://x.example.com", "https://x.example.com?a=1"]) {
      assert.ok(problemsOf(base({ CORS_ORIGINS: origin })).some((p) => p.startsWith("CORS_ORIGINS:")), origin);
    }
  });

  it("requires https in production except for localhost", () => {
    assert.ok(problemsOf(base({ NODE_ENV: "production", CORS_ORIGINS: "http://app.example.com" })).some((p) => p.includes("https")));
    assert.deepEqual(loadConfig(base({ NODE_ENV: "production", CORS_ORIGINS: "https://app.example.com" })).http.corsOrigins, ["https://app.example.com"]);
    assert.deepEqual(loadConfig(base({ NODE_ENV: "production", CORS_ORIGINS: "http://localhost:3000" })).http.corsOrigins, ["http://localhost:3000"]);
  });
});

describe("AI provider is optional", () => {
  it("defaults to disabled without failing startup", () => {
    const { ai } = loadConfig(base());
    assert.equal(ai.provider, "none");
    assert.equal(ai.enabled, false);
  });

  it("does not fail startup when a provider is chosen but its key is missing", () => {
    const openai = loadConfig(base({ AI_PROVIDER: "openai" })).ai;
    assert.equal(openai.enabled, false);
    assert.match(openai.disabledReason ?? "", /OPENAI_API_KEY/);
    const gemini = loadConfig(base({ AI_PROVIDER: "gemini" })).ai;
    assert.equal(gemini.enabled, false);
    assert.match(gemini.disabledReason ?? "", /GEMINI_API_KEY/);
  });

  it("does not report an unimplemented Gemini adapter as enabled when a key is present", () => {
    const { ai } = loadConfig(base({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k-test-value" }));
    assert.equal(ai.enabled, false);
    assert.match(ai.disabledReason ?? "", /not implemented/i);
    assert.equal(ai.apiKey, undefined);
  });

  it("enables the provider when a key is present", () => {
    const { ai } = loadConfig(base({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k-test-value" }));
    assert.equal(ai.enabled, true);
    assert.equal(ai.apiKey?.reveal(), "k-test-value");
  });

  it("rejects unknown providers", () => {
    assert.ok(problemsOf(base({ AI_PROVIDER: "skynet" })).some((p) => p.startsWith("AI_PROVIDER:")));
  });
});

describe("secrets cannot leak through serialisation", () => {
  const config = loadConfig(base({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k-live-abcdef123456" }));

  it("JSON.stringify, String and util.inspect never reveal secrets", () => {
    for (const text of [JSON.stringify(config), String(config.database.url), `${config.redis.url}`, inspect(config, { depth: 10 })]) {
      assert.ok(!text.includes(DB_PASSWORD), "db password leaked");
      assert.ok(!text.includes(REDIS_PASSWORD), "redis password leaked");
      assert.ok(!text.includes("k-live-abcdef123456"), "api key leaked");
    }
  });

  it("reveal() is the only way to read a secret", () => {
    assert.ok(config.database.url.reveal().includes(DB_PASSWORD));
  });

  it("describeConfig masks passwords but keeps host and port for debugging", () => {
    const text = JSON.stringify(describeConfig(config));
    assert.ok(!text.includes(DB_PASSWORD));
    assert.ok(!text.includes(REDIS_PASSWORD));
    assert.ok(!text.includes("k-live-abcdef123456"));
    assert.ok(text.includes("127.0.0.1:5434"));
  });
});

describe("real-time configuration", () => {
  it("is on by default and re-checks connections every 10 seconds", () => {
    const config = loadConfig(base());
    assert.deepEqual(config.realtime, { enabled: true, revalidateSeconds: 10 });
    assert.deepEqual(describeConfig(config).realtime, { enabled: true, revalidateSeconds: 10 });
  });

  it("can be switched off and tuned", () => {
    const config = loadConfig(base({ REALTIME_ENABLED: "false", REALTIME_REVALIDATE_SECONDS: "30" }));
    assert.deepEqual(config.realtime, { enabled: false, revalidateSeconds: 30 });
  });

  it("refuses an ambiguous REALTIME_ENABLED instead of guessing (the reference's Boolean(string) bug)", () => {
    assert.ok(problemsOf(base({ REALTIME_ENABLED: "maybe" })).some((p) => p.startsWith("REALTIME_ENABLED:")));
  });

  it.each(["0", "301", "abc", "1.5"])("refuses REALTIME_REVALIDATE_SECONDS=%s", (value) => {
    assert.ok(problemsOf(base({ REALTIME_REVALIDATE_SECONDS: value })).some((p) => p.startsWith("REALTIME_REVALIDATE_SECONDS:")));
  });
});
