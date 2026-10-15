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
});
