import assert from "node:assert/strict";
import type { IncidentDto } from "@platform/shared";
import { toErrorResponse } from "../http/error-response";
import type { HttpRequest, HttpResult } from "../http/http-types";
import { createTestApp, type RegisteredUser, type TestApp } from "../test-support/app-harness";

const ORIGIN = "http://localhost:3000";

function request(cookie: string, incidentId: string): HttpRequest {
  return {
    method: "GET",
    ip: "198.51.100.20",
    headers: { cookie: `sid=${encodeURIComponent(cookie)}`, origin: ORIGIN },
    body: undefined,
    query: {},
    params: { id: incidentId },
  };
}

async function call(promise: Promise<HttpResult>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    const result = await promise;
    return { status: result.status, body: result.body as Record<string, unknown> };
  } catch (error) {
    const result = toErrorResponse(error);
    return { status: result.status, body: result.body as Record<string, unknown> };
  }
}

describe("similar incidents (real PostgreSQL)", () => {
  let app: TestApp;
  let owner: RegisteredUser;

  beforeEach(async () => {
    app = await createTestApp();
    owner = await app.register("similar-owner@example.com");
  });

  afterEach(async () => {
    await app.close();
  });

  async function createIncident(
    user: RegisteredUser,
    input: { title: string; description?: string; severity?: "sev1" | "sev2" | "sev3" | "sev4" },
  ): Promise<IncidentDto> {
    return app.incidents.create(user.auth, {
      title: input.title,
      description: input.description ?? "",
      severity: input.severity ?? "sev2",
    });
  }

  async function resolve(
    incident: IncidentDto,
    resolution?: { rootCause: string; fixApplied: string },
  ): Promise<void> {
    await app.incidents.transition(owner.auth, incident.id, { to: "resolved", expectedVersion: incident.version });
    if (resolution) await app.incidents.createResolution(owner.auth, incident.id, resolution);
  }

  it("ranks relevant resolved matches, excludes source/unresolved/foreign-tenant incidents, and returns resolution data", async () => {
    const source = await createIncident(owner, {
      title: "Gateway VNX-77 connection timeout",
      description: "Checkout database pool saturation",
    });
    await resolve(source, { rootCause: "Worker exhaustion", fixApplied: "Expanded connection pool" });

    const relevant = await createIncident(owner, {
      title: "Gateway VNX/77 checkout connection timeout",
      description: "Database pool saturation caused checkout failures",
      severity: "sev1",
    });
    await resolve(relevant, { rootCause: "Worker saturation", fixApplied: "Expanded database capacity" });

    const weaker = await createIncident(owner, { title: "Gateway maintenance completed" });
    await resolve(weaker);

    const unresolved = await createIncident(owner, {
      title: "Gateway VNX 77 checkout connection timeout database pool",
    });
    await app.incidents.createResolution(owner.auth, unresolved.id, {
      rootCause: "Still being investigated",
      fixApplied: "No fix yet",
    });

    const foreign = await app.register("similar-foreign@example.com");
    const foreignMatch = await createIncident(foreign, {
      title: "Gateway VNX 77 checkout connection timeout database pool saturation",
    });
    await app.incidents.transition(foreign.auth, foreignMatch.id, { to: "resolved", expectedVersion: 1 });
    await app.incidents.createResolution(foreign.auth, foreignMatch.id, {
      rootCause: "Foreign tenant root cause",
      fixApplied: "Foreign tenant fix",
    });

    const viewer = await app.join(owner, "similar-viewer@example.com", "viewer");
    const response = await call(app.handlers.similarIncidents(request(viewer.token, source.id)));
    assert.equal(response.status, 200);
    const results = response.body.results as Array<Record<string, unknown>>;
    assert.ok(results.length >= 2);
    assert.equal(results[0]?.id, relevant.id, "the stronger text match must rank ahead of the weaker match");
    assert.ok(!results.some((result) => result.id === source.id), "the source incident must be excluded");
    assert.ok(!results.some((result) => result.id === unresolved.id), "unresolved candidates must be excluded");
    assert.ok(!results.some((result) => result.id === foreignMatch.id), "foreign-tenant candidates must be excluded");
    assert.equal(results[0]?.rootCause, "Worker saturation");
    assert.equal(results[0]?.fixApplied, "Expanded database capacity");
    assert.ok((results[0]?.matchedTerms as string[]).includes("vnx"));
    assert.ok(results.every((result) => typeof result.title === "string" && typeof result.severity === "string"));
  });

  it("returns no matches when the source has no searchable tokens or nothing matches", async () => {
    const punctuationOnly = await createIncident(owner, { title: "!!! --- ???", description: "___" });
    assert.deepEqual(
      (await call(app.handlers.similarIncidents(request(owner.token, punctuationOnly.id)))).body,
      { results: [] },
    );

    const unmatched = await createIncident(owner, { title: "qzxvplmno unusualidentifier" });
    assert.deepEqual((await app.incidents.similar(owner.auth, unmatched.id)).results, []);
  });

  it("normalizes punctuation in identifiers and returns an empty resolution when text is unavailable", async () => {
    const source = await createIncident(owner, { title: "Service QRS-9087 outage" });
    const candidate = await createIncident(owner, { title: "QRS/9087 outage fixed", severity: "sev3" });
    await resolve(candidate);

    const results = (await app.incidents.similar(owner.auth, source.id)).results;
    assert.equal(results[0]?.id, candidate.id);
    assert.equal(results[0]?.rootCause, null);
    assert.equal(results[0]?.fixApplied, null);
    assert.ok(results[0]?.matchedTerms.includes("qrs"));
  });

  it("caps results at five and limits search terms from long source descriptions", async () => {
    const source = await createIncident(owner, {
      title: "common gateway event",
      description: "amberbirch copperdawn cobaltfield emeraldgate frostharbor goldenisle hazelridge indigosummit junipertrail kettlemeadow luminlake midnightorchard northwindpath overcastplaza",
    });
    const excludedByTermCap = await createIncident(owner, { title: "overcastplaza only candidate" });
    await resolve(excludedByTermCap);
    for (let index = 0; index < 7; index += 1) {
      const candidate = await createIncident(owner, {
        title: `common gateway event resolved${index}`,
      });
      await resolve(candidate);
    }

    const results = (await app.incidents.similar(owner.auth, source.id)).results;
    assert.equal(results.length, 5);
    assert.ok(!results.some((result) => result.id === excludedByTermCap.id), "terms beyond the cap must not enter the query");
  });

  it("keeps malformed and cross-tenant source identifiers on the not-found path", async () => {
    const local = await createIncident(owner, { title: "local source" });
    const foreign = await app.register("similar-404-foreign@example.com");
    const foreignIncident = await createIncident(foreign, { title: "foreign source" });

    assert.equal((await call(app.handlers.similarIncidents(request(owner.token, "not-a-uuid")))).status, 404);
    assert.equal((await call(app.handlers.similarIncidents(request(owner.token, foreignIncident.id)))).status, 404);
    const unauthorized = await call(app.handlers.similarIncidents(request("not-a-session-token", local.id)));
    assert.equal(unauthorized.status, 401);
  });

  it("treats identifier-looking and tsquery-looking text as data, not query syntax", async () => {
    const source = await createIncident(owner, {
      title: "QRS-777'); DROP TABLE incidents; --",
      description: "alpha | !*:* beta",
    });
    const result = await app.incidents.similar(owner.auth, source.id);
    assert.deepEqual(result, { results: [] });
    const table = await app.testDb.query<{ present: boolean }>("SELECT to_regclass('incidents') IS NOT NULL AS present");
    assert.equal(table[0]?.present, true);
  });
});
