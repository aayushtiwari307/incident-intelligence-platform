import assert from "node:assert/strict";
import { ApiError, createApiClient, type FetchLike } from "./api-client";

interface Call {
  url: string;
  init?: RequestInit;
}

function stub(status: number, body?: unknown): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  };
  return { fetch: fetchImpl, calls };
}

describe("api client", () => {
  it("supports same-origin requests when the configured base URL is empty", async () => {
    const s = stub(200, {
      user: { id: "u1", email: "owner@example.com", displayName: "Owner" },
      memberships: [], activeOrganizationId: "org-1", role: "owner",
    });
    await createApiClient("", s.fetch).me();
    assert.equal((s.calls[0] as Call).url, "/api/auth/me");
    assert.equal((s.calls[0] as Call).init?.credentials, "include");
  });

  it("always sends credentials, never an organization id, and JSON bodies with a content type", async () => {
    const s = stub(201, { id: "i1" });
    const api = createApiClient("http://api.test/", s.fetch);
    await api.createIncident({ title: "t", description: "", severity: "sev3" });
    const call = s.calls[0] as Call;
    assert.equal(call.url, "http://api.test/api/incidents");
    assert.equal(call.init?.credentials, "include");
    assert.deepEqual(call.init?.headers, { "Content-Type": "application/json" });
    assert.ok(!String(call.init?.body).includes("organization"));
  });

  it("registers invitees through the dedicated endpoint without an organization name", async () => {
    const s = stub(201, { activeOrganizationId: "org-1", role: "viewer" });
    const api = createApiClient("http://api.test", s.fetch);
    await api.registerWithInvite({ email: "member@example.com", password: "long enough password", displayName: "Member", inviteToken: "a".repeat(43) });
    const call = s.calls[0] as Call;
    assert.equal(call.url, "http://api.test/api/auth/register-with-invite");
    assert.deepEqual(JSON.parse(String(call.init?.body)), {
      email: "member@example.com",
      password: "long enough password",
      displayName: "Member",
      inviteToken: "a".repeat(43),
    });
  });

  it("builds query strings from set filters only and encodes path segments", async () => {
    const s = stub(200, { items: [], nextCursor: null });
    const api = createApiClient("http://api.test", s.fetch);
    await api.listIncidents({ status: "triggered", assignee: "me", severity: undefined, cursor: "" });
    assert.equal((s.calls[0] as Call).url, "http://api.test/api/incidents?status=triggered&assignee=me");
    const s2 = stub(200, {});
    await createApiClient("http://api.test", s2.fetch).getIncident("a/b?c");
    assert.equal((s2.calls[0] as Call).url, "http://api.test/api/incidents/a%2Fb%3Fc");
  });

  it("unwraps list envelopes and handles 204 without a body", async () => {
    const s = stub(200, { items: [{ userId: "u" }] });
    assert.deepEqual(JSON.parse(JSON.stringify(await createApiClient("http://a", s.fetch).listMembers())), [{ userId: "u" }]);
    await assert.doesNotReject(createApiClient("http://a", stub(204).fetch).logout());
  });

  it("turns error bodies into ApiError with code, status and details", async () => {
    const s = stub(409, { error: { code: "VERSION_CONFLICT", message: "stale", details: { currentVersion: 4 } } });
    await assert.rejects(createApiClient("http://a", s.fetch).getIncident("x"), (e: unknown) => {
      assert.ok(e instanceof ApiError);
      assert.equal(e.status, 409);
      assert.equal(e.code, "VERSION_CONFLICT");
      assert.deepEqual(JSON.parse(JSON.stringify(e.details)), { currentVersion: 4 });
      return true;
    });
  });

  it("exposes field errors for validation failures (first message per field)", () => {
    const e = new ApiError(400, "VALIDATION_FAILED", "bad", [
      { path: "email", message: "Invalid email" },
      { path: "email", message: "other" },
      { path: "password", message: "Too short" },
    ]);
    assert.deepEqual(e.fieldErrors, { email: "Invalid email", password: "Too short" });
    assert.deepEqual(new ApiError(404, "NOT_FOUND", "x").fieldErrors, {});
  });

  it("maps network failures and non-JSON error pages to friendly ApiErrors", async () => {
    const down: FetchLike = async () => {
      throw new TypeError("fetch failed");
    };
    await assert.rejects(createApiClient("http://a", down).me(), (e: unknown) => e instanceof ApiError && e.code === "NETWORK" && e.status === 0);
    const html: FetchLike = async () => new Response("<html>502</html>", { status: 502 });
    await assert.rejects(createApiClient("http://a", html).me(), (e: unknown) => e instanceof ApiError && e.code === "UNKNOWN" && e.status === 502);
  });

  it("analysis endpoints use GET for state and POST (no body) to request a run", async () => {
    const s = stub(200, { enabled: true, analysis: null });
    const api = createApiClient("http://api.test", s.fetch);
    await api.analysisState("i1");
    await api.requestAnalysis("i1");
    assert.equal((s.calls[0] as Call).url, "http://api.test/api/incidents/i1/analysis");
    assert.equal((s.calls[0] as Call).init?.method, "GET");
    assert.equal((s.calls[1] as Call).init?.method, "POST");
    assert.equal((s.calls[1] as Call).init?.body, undefined);
  });

  it("uses the existing similar-incidents and resolution contracts with session credentials", async () => {
    const similar = stub(200, { results: [] });
    const api = createApiClient("http://api.test", similar.fetch);
    await api.similarIncidents("incident/1");
    assert.equal((similar.calls[0] as Call).url, "http://api.test/api/incidents/incident%2F1/similar");
    assert.equal((similar.calls[0] as Call).init?.method, "GET");
    assert.equal((similar.calls[0] as Call).init?.credentials, "include");

    const resolution = stub(201, { incidentId: "i1", rootCause: "cause", fixApplied: "fix", version: 1 });
    await createApiClient("http://api.test", resolution.fetch).createIncidentResolution("i1", {
      rootCause: "cause",
      fixApplied: "fix",
    });
    const call = resolution.calls[0] as Call;
    assert.equal(call.url, "http://api.test/api/incidents/i1/resolution");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.credentials, "include");
    assert.deepEqual(JSON.parse(String(call.init?.body)), { rootCause: "cause", fixApplied: "fix" });
    assert.ok(!String(call.init?.body).includes("organizationId"));
    assert.ok(!String(call.init?.body).includes("resolvedBy"));

    const savedResolution = stub(200, { incidentId: "i1", rootCause: "cause", fixApplied: "fix", version: 1 });
    await createApiClient("http://api.test", savedResolution.fetch).getIncidentResolution("incident/1");
    assert.equal((savedResolution.calls[0] as Call).url, "http://api.test/api/incidents/incident%2F1/resolution");
    assert.equal((savedResolution.calls[0] as Call).init?.method, "GET");
    assert.equal((savedResolution.calls[0] as Call).init?.credentials, "include");
  });

  it("integration calls use the session cookie, send no organization id and encode ids", async () => {
    const s = stub(201, { id: "i1", token: "t".repeat(43) });
    const api = createApiClient("http://api.test", s.fetch);
    await api.createIntegration("prod alertmanager");
    const create = s.calls[0] as Call;
    assert.equal(create.url, "http://api.test/api/organization/integrations");
    assert.equal(create.init?.method, "POST");
    assert.equal(create.init?.credentials, "include");
    assert.deepEqual(JSON.parse(String(create.init?.body)), { name: "prod alertmanager" });

    await api.rotateIntegration("a/b");
    assert.equal((s.calls[1] as Call).url, "http://api.test/api/organization/integrations/a%2Fb/rotate");
    assert.equal((s.calls[1] as Call).init?.method, "POST");
    await api.revokeIntegration("a/b");
    assert.equal((s.calls[2] as Call).url, "http://api.test/api/organization/integrations/a%2Fb");
    assert.equal((s.calls[2] as Call).init?.method, "DELETE");
    for (const call of s.calls) assert.ok(!String(call.init?.body ?? "").includes("organization"));
  });

  it("lists integrations from the items envelope", async () => {
    const s = stub(200, { items: [{ id: "i1", name: "n", status: "active" }] });
    const items = await createApiClient("http://api.test", s.fetch).listIntegrations();
    assert.equal(items.length, 1);
    assert.equal((s.calls[0] as Call).url, "http://api.test/api/organization/integrations");
  });

  it("calls the AI suggestion endpoints with only an incident id, a suggestion id and an apply target (never an organization id)", async () => {
    const s = stub(200, {});
    const api = createApiClient("http://api.test", s.fetch);
    await api.aiSuggestionState("i 1");
    await api.requestAiSuggestion("i1");
    await api.applyAiSuggestion("i1", "s1", "comment");
    await api.dismissAiSuggestion("i1", "s1");
    await api.aiSettings();
    await api.updateAiSettings(true);
    const seen = s.calls.map((c) => `${c.init?.method} ${c.url}`);
    assert.deepEqual(seen, [
      "GET http://api.test/api/incidents/i%201/ai-suggestions",
      "POST http://api.test/api/incidents/i1/ai-suggestions",
      "POST http://api.test/api/incidents/i1/ai-suggestions/s1/apply",
      "POST http://api.test/api/incidents/i1/ai-suggestions/s1/dismiss",
      "GET http://api.test/api/organization/ai-settings",
      "PUT http://api.test/api/organization/ai-settings",
    ]);
    assert.equal(s.calls[2]?.init?.body, JSON.stringify({ target: "comment" }));
    assert.equal(s.calls[5]?.init?.body, JSON.stringify({ suggestionsEnabled: true }));
    assert.ok(!s.calls.some((c) => String(c.init?.body ?? "").includes("organization")));
  });
});
