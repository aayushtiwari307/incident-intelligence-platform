import "reflect-metadata";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "../app.module";
import { loadConfig } from "../config/env";
import { runMigrations } from "../db/migrate/runner";
import { createTestDatabase, type TestDatabase } from "../test-support/session-factory";
import { configureHttpApplication } from "./configure-http";
import { OPENAI_FETCH } from "./api.module";

const ORIGIN = "http://127.0.0.1:3000";
const MOCK_KEY = "local-e2e-only-key";
const MOCK_RESULT = {
  severity: "sev1",
  category: "availability",
  summary: "The service has elevated latency and requests are timing out.",
  probableCause: "A saturated connection pool is a plausible cause based on the incident description.",
  steps: ["Inspect active database connections", "Check pool saturation and slow queries"],
};

type ProviderRequest = { authorization: string | undefined; body: Record<string, unknown> };

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo | null;
  assert.ok(address && typeof address === "object");
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe("Nest HTTP to PostgreSQL queue to mocked OpenAI end-to-end", () => {
  let testDb: TestDatabase | undefined;
  let app: NestExpressApplication | undefined;
  let mockServer: Server | undefined;
  let baseUrl = "";
  let mockProviderUrl = "";
  const providerRequests: ProviderRequest[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await runMigrations(testDb.connect, {
      mode: "apply",
      directory: path.resolve(__dirname, "../../migrations"),
    });

    mockServer = createServer(async (request, response) => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        response.writeHead(400).end();
        return;
      }
      providerRequests.push({ authorization: request.headers.authorization, body });
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      response.end(JSON.stringify({
        id: `resp_local_${providerRequests.length}`,
        status: "completed",
        output: [{
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: JSON.stringify(MOCK_RESULT), annotations: [] }],
        }],
      }));
    });
    const mockPort = await listen(mockServer);
    mockProviderUrl = `http://127.0.0.1:${mockPort}/v1/responses`;

    const config = loadConfig({
      NODE_ENV: "test",
      API_HOST: "127.0.0.1",
      API_PORT: "3001",
      DATABASE_URL: testDb.connectionString,
      REDIS_URL: "redis://127.0.0.1:6380",
      CORS_ORIGINS: ORIGIN,
      TRUST_PROXY_HOPS: "0",
      MIGRATE_ON_START: "off",
      LOG_LEVEL: "error",
      AI_PROVIDER: "openai",
      OPENAI_API_KEY: MOCK_KEY,
      AI_MODEL: "local-e2e-model",
      AI_TIMEOUT_MS: "5000",
    });

    // Keep the provider's configured URL fixed at api.openai.com. This test-only transport redirects
    // that exact request to the local deterministic HTTP mock; no real provider network call is possible.
    const localProviderFetch: typeof fetch = async (input, init) => {
      const requested = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      assert.equal(requested, "https://api.openai.com/v1/responses", "provider endpoint must remain fixed");
      return fetch(mockProviderUrl, init);
    };

    const testingModule = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] })
      .overrideProvider(OPENAI_FETCH)
      .useValue(localProviderFetch)
      .compile();

    app = testingModule.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureHttpApplication(app, config);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo | null;
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      try {
        if (mockServer) await closeServer(mockServer);
      } finally {
        await testDb?.drop();
      }
    }
  }, 30_000);

  async function request(pathname: string, options: { method?: string; cookie?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = response.status === 204 ? "" : await response.text();
    const body = text ? JSON.parse(text) as Record<string, unknown> : undefined;
    return { response, body };
  }

  async function waitForAnalysis(cookie: string, incidentId: string, deadline: number, expectedPreviousId?: string) {
    let latest: Record<string, unknown> | null = null;
    while (Date.now() < deadline) {
      const { response, body } = await request(`/api/incidents/${incidentId}/analysis`, { cookie });
      assert.equal(response.status, 200);
      const analysis = (body?.analysis ?? null) as Record<string, unknown> | null;
      if (analysis && analysis.id !== expectedPreviousId && (analysis.status === "completed" || analysis.status === "failed")) {
        latest = analysis;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(latest, `analysis did not reach a terminal state before timeout (incident ${incidentId})`);
    return latest;
  }

  it("registers, creates an incident, requests analysis, and applies severity through the audited HTTP path", async () => {
    const registration = await request("/api/auth/register", {
      method: "POST",
      body: {
        email: "nest-e2e@example.com",
        password: "a-valid-e2e-password-123",
        displayName: "Nest E2E Owner",
        organizationName: "Nest E2E Organization",
      },
    });
    assert.equal(registration.response.status, 201, JSON.stringify(registration.body));
    const setCookie = registration.response.headers.get("set-cookie");
    assert.ok(setCookie, "real Nest controller should set the session cookie");
    const cookie = setCookie.split(";")[0] as string;
    assert.ok(cookie.startsWith("sid="), "test environment should use the non-Secure session cookie");

    const creation = await request("/api/incidents", {
      method: "POST",
      cookie,
      body: {
        title: "API response latency elevated",
        description: "p99 latency rose after deployment and a subset of requests times out",
        severity: "sev3",
      },
    });
    assert.equal(creation.response.status, 201, JSON.stringify(creation.body));
    const incidentId = String(creation.body?.id ?? "");
    assert.ok(incidentId, "incident was persisted through the HTTP controller");
    const initialVersion = Number(creation.body?.version);

    // The current product automatically queues first analysis with incident creation. Wait for it to
    // complete, then explicitly exercise the request-analysis endpoint for a second analysis.
    const analysisDeadline = Date.now() + 25_000;
    const initial = await waitForAnalysis(cookie, incidentId, analysisDeadline);
    assert.equal(initial.status, "completed", JSON.stringify(initial));

    const reanalysisRequest = await request(`/api/incidents/${incidentId}/analysis`, { method: "POST", cookie });
    assert.equal(reanalysisRequest.response.status, 202, JSON.stringify(reanalysisRequest.body));
    const finalAnalysis = await waitForAnalysis(cookie, incidentId, analysisDeadline, String(initial.id));
    assert.equal(finalAnalysis.status, "completed", JSON.stringify(finalAnalysis));
    assert.equal(finalAnalysis.suggestedSeverity, "sev1");
    assert.equal(providerRequests.length, 2, "both analyses must pass through the actual OpenAI provider transport");
    assert.ok(providerRequests.every((request) => request.authorization === `Bearer ${MOCK_KEY}`));
    assert.ok(providerRequests.every((request) => request.body.store === false));
    assert.ok(providerRequests.every((request) => JSON.stringify(request.body.input).includes("API response latency elevated")));
    assert.ok(providerRequests.every((request) => !JSON.stringify(request.body.input).includes("nest-e2e@example.com")));
    assert.equal(mockProviderUrl.startsWith("http://127.0.0.1:"), true);

    const applied = await request(`/api/incidents/${incidentId}`, {
      method: "PATCH",
      cookie,
      body: { expectedVersion: initialVersion, severity: finalAnalysis.suggestedSeverity },
    });
    assert.equal(applied.response.status, 200, JSON.stringify(applied.body));
    assert.equal(applied.body?.severity, "sev1");

    const timeline = await request(`/api/incidents/${incidentId}/timeline`, { cookie });
    assert.equal(timeline.response.status, 200);
    const items = timeline.body?.items as Array<{ type?: string; payload?: Record<string, unknown> }>;
    assert.ok(Array.isArray(items));
    assert.ok(items.some((event) => event.type === "severity_changed" && event.payload?.to === "sev1"), "applied severity must produce the ordinary audit event");

    const savedResolution = await request(`/api/incidents/${incidentId}/resolution`, {
      method: "POST",
      cookie,
      body: { rootCause: "Saturated connection pool", fixApplied: "Expanded pool capacity" },
    });
    assert.equal(savedResolution.response.status, 201, JSON.stringify(savedResolution.body));
    const readResolution = await request(`/api/incidents/${incidentId}/resolution`, { cookie });
    assert.equal(readResolution.response.status, 200, JSON.stringify(readResolution.body));
    assert.equal(readResolution.body?.rootCause, "Saturated connection pool");
    const similar = await request(`/api/incidents/${incidentId}/similar`, { cookie });
    assert.equal(similar.response.status, 200, JSON.stringify(similar.body));
    assert.deepEqual(similar.body, { results: [] });

    const unauthorized = await request(`/api/incidents/${incidentId}/analysis`);
    assert.equal(unauthorized.response.status, 401, "real Nest auth middleware must reject requests without a session");
    assert.equal((await request(`/api/incidents/${incidentId}/similar`)).response.status, 401);

    // Tenant isolation through the real HTTP stack: another organization's owner cannot read or trigger analysis
    // for this incident (not-found, never forbidden), and nothing reaches the provider on their behalf.
    const other = await request("/api/auth/register", {
      method: "POST",
      body: {
        email: "nest-e2e-other@example.com",
        password: "a-valid-e2e-password-123",
        displayName: "Other Owner",
        organizationName: "Other Organization",
      },
    });
    assert.equal(other.response.status, 201, JSON.stringify(other.body));
    const otherCookie = (other.response.headers.get("set-cookie") ?? "").split(";")[0] as string;
    assert.ok(otherCookie.startsWith("sid="));
    const crossRead = await request(`/api/incidents/${incidentId}/analysis`, { cookie: otherCookie });
    assert.equal(crossRead.response.status, 404, "another tenant must not see this incident's analysis");
    assert.equal(
      (await request(`/api/incidents/${incidentId}/similar`, { cookie: otherCookie })).response.status,
      404,
      "another tenant must not see this incident's similar results",
    );
    const crossRequest = await request(`/api/incidents/${incidentId}/analysis`, { method: "POST", cookie: otherCookie });
    assert.equal(crossRequest.response.status, 404, "another tenant must not trigger analysis");
    assert.equal(providerRequests.length, 2, "a cross-tenant request must not reach the provider");
  }, 30_000);
});
