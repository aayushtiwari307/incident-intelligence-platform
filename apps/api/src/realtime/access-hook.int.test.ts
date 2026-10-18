import assert from "node:assert/strict";
import { ApiHandlers } from "../http/api-handlers";
import type { HttpRequest, HttpResult } from "../http/http-types";
import { createTestApp, type RegisteredUser, type TestApp } from "../test-support/app-harness";

const ORIGIN = "http://localhost:3000";

function req(user: RegisteredUser | null, partial: Partial<HttpRequest> = {}): HttpRequest {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (user) headers.cookie = `sid=${encodeURIComponent(user.token)}`;
  return { method: "POST", ip: "198.51.100.20", body: undefined, query: {}, params: {}, ...partial, headers };
}

/** The API hands the real-time layer a signal whenever a change could end someone's right to receive pushes. */
describe("access-change hook (real PostgreSQL)", () => {
  let app: TestApp;
  let calls: number;
  let handlers: ApiHandlers;

  const build = (hook: () => void): ApiHandlers =>
    new ApiHandlers(app.auth, app.organizations, app.incidents, app.analysis, app.integrations, app.aiSuggestions, {
      allowedOrigins: [ORIGIN],
      secureCookies: false,
      sessionTtlSeconds: 3600,
      onAccessChanged: hook,
    });

  beforeEach(async () => {
    app = await createTestApp();
    calls = 0;
    handlers = build(() => void (calls += 1));
  });
  afterEach(async () => {
    await app.close();
  });

  it("fires after logout", async () => {
    const user = await app.register("hook-logout@example.com");
    await handlers.logout(req(user));
    assert.equal(calls, 1);
  });

  it("fires after removing a member", async () => {
    const owner = await app.register("hook-owner@example.com");
    const member = await app.join(owner, "hook-member@example.com", "viewer");
    await handlers.removeMember(req(owner, { method: "DELETE", params: { userId: member.auth.userId } }));
    assert.equal(calls, 1);
  });

  it("fires after switching organization", async () => {
    const owner = await app.register("hook-switch-owner@example.com");
    const member = await app.join(owner, "hook-switch-member@example.com", "viewer");
    const me = await app.auth.me(member.auth);
    const personal = me.memberships.find((m) => m.organizationId !== owner.auth.organizationId);
    assert.ok(personal);
    await handlers.switchOrganization(req(member, { body: { organizationId: personal.organizationId } }));
    assert.equal(calls, 1);
  });

  it("does not fire when the request fails", async () => {
    const owner = await app.register("hook-fail-owner@example.com");
    await assert.rejects(() => handlers.removeMember(req(owner, { method: "DELETE", params: { userId: "00000000-0000-4000-8000-000000000000" } })));
    assert.equal(calls, 0);
  });

  it("never turns a successful request into a failure when the hook throws", async () => {
    const user = await app.register("hook-throw@example.com");
    const throwing = build(() => {
      throw new Error("hook exploded");
    });
    const result: HttpResult = await throwing.logout(req(user));
    assert.equal(result.status, 204);
  });
});
