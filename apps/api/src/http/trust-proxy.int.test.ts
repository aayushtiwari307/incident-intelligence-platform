import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../app.module";
import { loadConfig } from "../config/env";
import { runMigrations } from "../db/migrate/runner";
import { createTestDatabase, type TestDatabase } from "../test-support/session-factory";
import { configureHttpApplication } from "./configure-http";

/**
 * R5: what the API believes a client's IP address is decides which rate-limit bucket it lands in, so it must follow
 * TRUST_PROXY_HOPS exactly:
 *   hops=0  -> forwarded headers are client-controlled text and must be ignored (else anyone can dodge the limiter);
 *   hops=1  -> exactly one trusted reverse proxy: the address it appended (rightmost X-Forwarded-For entry) is the
 *              client; anything a client put to the left of it must stay ignored.
 *
 * Observed through the real stack (Nest controllers, Express `trust proxy`, AuthService limiter): the login limiter
 * allows 5 attempts per "email|ip" key and answers the 6th with 429. These tests also boot WITHOUT REDIS_URL, which
 * proves the API does not need Redis (R4, "absent" case).
 */
const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "a-valid-e2e-password-123";
const LOGIN_ATTEMPTS_PER_KEY = 5;

interface Booted {
  app: NestExpressApplication;
  testDb: TestDatabase;
  baseUrl: string;
}

async function boot(trustProxyHops: number): Promise<Booted> {
  const testDb = await createTestDatabase();
  await runMigrations(testDb.connect, { mode: "apply", directory: path.resolve(__dirname, "../../migrations") });
  const config = loadConfig({
    NODE_ENV: "test",
    API_HOST: "127.0.0.1",
    API_PORT: "3001",
    DATABASE_URL: testDb.connectionString,
    // REDIS_URL deliberately absent.
    CORS_ORIGINS: ORIGIN,
    TRUST_PROXY_HOPS: String(trustProxyHops),
    MIGRATE_ON_START: "off",
    LOG_LEVEL: "error",
    AI_PROVIDER: "none",
    REALTIME_ENABLED: "false",
  });
  assert.equal(config.redis, null, "this suite must run without Redis configured");
  const testingModule = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
  const app = testingModule.createNestApplication<NestExpressApplication>({ bodyParser: false });
  configureHttpApplication(app, config);
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo | null;
  assert.ok(address && typeof address === "object");
  return { app, testDb, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function shutdown(booted: Booted | undefined): Promise<void> {
  try {
    await booted?.app.close();
  } finally {
    await booted?.testDb.drop();
  }
}

async function login(booted: Booted, email: string, forwardedFor?: string, extra: Record<string, string> = {}): Promise<number> {
  const headers: Record<string, string> = { Origin: ORIGIN, "Content-Type": "application/json", ...extra };
  if (forwardedFor !== undefined) headers["X-Forwarded-For"] = forwardedFor;
  const response = await fetch(`${booted.baseUrl}/api/auth/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  await response.text();
  return response.status;
}

/** Sends N login attempts for one email, one per forwarded-for value, and returns the status codes in order. */
async function attempts(booted: Booted, email: string, forwardedFor: Array<string | undefined>): Promise<number[]> {
  const statuses: number[] = [];
  for (const value of forwardedFor) statuses.push(await login(booted, email, value));
  return statuses;
}

const six = (make: (n: number) => string | undefined): Array<string | undefined> => Array.from({ length: LOGIN_ATTEMPTS_PER_KEY + 1 }, (_, i) => make(i + 1));

describe("TRUST_PROXY_HOPS=0 (no proxy): forwarded IP headers are ignored", () => {
  let booted: Booted | undefined;
  beforeAll(async () => {
    booted = await boot(0);
  }, 60_000);
  afterAll(() => shutdown(booted), 30_000);

  it("a client cannot dodge the per-account throttle by sending a different X-Forwarded-For every time", async () => {
    // Every request really comes from 127.0.0.1. If the header were believed, each would get its own bucket.
    const statuses = await attempts(booted as Booted, "spoof-ignored@example.com", six((n) => `203.0.113.${n}`));
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  }, 60_000);

  it("also ignores X-Real-IP and the standard Forwarded header", async () => {
    const b = booted as Booted;
    const statuses: number[] = [];
    for (let n = 1; n <= LOGIN_ATTEMPTS_PER_KEY + 1; n++) {
      statuses.push(await login(b, "spoof-other-headers@example.com", undefined, { "X-Real-IP": `198.51.100.${n}`, Forwarded: `for=192.0.2.${n}` }));
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  }, 60_000);
});

describe("TRUST_PROXY_HOPS=1 (one trusted reverse proxy): the address the proxy appended is the client", () => {
  let booted: Booted | undefined;
  beforeAll(async () => {
    booted = await boot(1);
  }, 60_000);
  afterAll(() => shutdown(booted), 30_000);

  it("separates clients by the address the trusted proxy reports, so one site-wide bucket does not form behind the proxy", async () => {
    // A single header value is what a proxy that overwrites X-Forwarded-For sends. Six different clients, one attempt
    // each, are six different buckets: nobody is throttled by someone else's failures.
    const statuses = await attempts(booted as Booted, "behind-proxy@example.com", six((n) => `203.0.113.${n}`));
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401]);
  }, 60_000);

  it("still throttles one client, and leftmost entries a client prepends cannot reset its bucket", async () => {
    // Real proxy behaviour when a client lies: the client's own value stays on the left, the proxy appends the true
    // peer on the right. Only the rightmost entry (one trusted hop) counts, so these are all the same client.
    const statuses = await attempts(booted as Booted, "prepended@example.com", six((n) => `10.9.9.${n}, 198.51.100.50`));
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  }, 60_000);

  it("falls back to the socket address when no forwarded header is present", async () => {
    const statuses = await attempts(booted as Booted, "no-header@example.com", six(() => undefined));
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
  }, 60_000);
});
