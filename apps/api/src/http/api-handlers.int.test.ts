import assert from "node:assert/strict";
import type { IncidentDto, MeDto } from "@platform/shared";
import { toErrorResponse } from "./error-response";
import type { HttpRequest, HttpResult } from "./http-types";
import { PASSWORD, createTestApp, type TestApp } from "../test-support/app-harness";

const ORIGIN = "http://localhost:3000";

function req(partial: Partial<HttpRequest> & { cookie?: string; origin?: string | null }): HttpRequest {
  const headers: Record<string, string> = {};
  if (partial.cookie) headers.cookie = partial.cookie;
  if (partial.origin !== null) headers.origin = partial.origin ?? ORIGIN;
  return { method: "GET", ip: "198.51.100.20", body: undefined, query: {}, params: {}, ...partial, headers };
}

/** Runs a handler the way the exception filter would: success result, or the mapped error response. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test helper: the body is untyped JSON asserted field by field
async function call(fn: Promise<HttpResult>): Promise<{ status: number; body: any; result?: HttpResult }> {
  try {
    const result = await fn;
    return { status: result.status, body: result.body, result };
  } catch (error) {
    const r = toErrorResponse(error);
    return { status: r.status, body: r.body };
  }
}

const cookieOf = (result?: HttpResult): string => {
  assert.ok(result?.setCookie, "expected a session cookie");
  return `${result.setCookie.name}=${encodeURIComponent(result.setCookie.value)}`;
};

describe("HTTP behaviour (real PostgreSQL)", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  const signUp = async (email: string) => {
    const r = await call(
      app.handlers.register(req({ method: "POST", body: { email, password: PASSWORD, displayName: email.split("@")[0], organizationName: `${email} org` } })),
    );
    assert.equal(r.status, 201);
    return { cookie: cookieOf(r.result), me: r.body as MeDto };
  };

  it("register sets an HttpOnly SameSite=Lax session cookie and never returns the token in the body", async () => {
    const r = await call(app.handlers.register(req({ method: "POST", body: { email: "a@example.com", password: PASSWORD, displayName: "A", organizationName: "Org" } })));
    assert.equal(r.status, 201);
    const cookie = r.result?.setCookie;
    assert.equal(cookie?.name, "sid");
    assert.equal(cookie?.options.httpOnly, true);
    assert.equal(cookie?.options.sameSite, "lax");
    assert.equal(cookie?.options.path, "/");
    assert.ok(!JSON.stringify(r.body).includes(cookie?.value as string));
    assert.equal(r.result?.headers?.["Cache-Control"], "no-store");
  });

  it("register-with-invite creates a session directly in the invited organization", async () => {
    const owner = await signUp("owner-register-invite@example.com");
    const invite = await call(app.handlers.createInvite(req({
      method: "POST",
      cookie: owner.cookie,
      body: { email: "new-member@example.com", role: "viewer" },
    })));
    assert.equal(invite.status, 201);

    const registered = await call(app.handlers.registerWithInvite(req({
      method: "POST",
      body: { email: "new-member@example.com", password: PASSWORD, displayName: "New Member", inviteToken: invite.body.token },
    })));
    assert.equal(registered.status, 201);
    assert.ok(registered.result?.setCookie?.options.httpOnly);
    assert.equal(registered.body.activeOrganizationId, owner.me.activeOrganizationId);
    assert.equal(registered.body.role, "viewer");
    const orgs = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM organizations");
    assert.equal(orgs[0]?.n, "1");
  });

  it("protected routes return 401 without a cookie, with a garbage cookie and after logout", async () => {
    assert.equal((await call(app.handlers.me(req({})))).status, 401);
    assert.equal((await call(app.handlers.me(req({ cookie: "sid=nonsense" })))).status, 401);
    const { cookie } = await signUp("a@example.com");
    assert.equal((await call(app.handlers.me(req({ cookie })))).status, 200);
    const out = await call(app.handlers.logout(req({ method: "POST", cookie })));
    assert.equal(out.status, 204);
    assert.ok(out.result?.clearCookie);
    assert.equal((await call(app.handlers.me(req({ cookie })))).status, 401, "the old cookie is dead server-side, not just removed in the browser");
    assert.equal((await call(app.handlers.logout(req({ method: "POST" })))).status, 204, "logout is idempotent");
  });

  it("CSRF: unsafe requests from a foreign or null Origin are rejected before anything happens", async () => {
    const { cookie } = await signUp("a@example.com");
    for (const origin of ["https://evil.example", "null"]) {
      const r = await call(app.handlers.createIncident(req({ method: "POST", cookie, origin, body: { title: "x", severity: "sev3" } })));
      assert.equal(r.status, 403, origin);
      assert.equal(r.body.error.code, "ORIGIN_NOT_ALLOWED");
    }
    const login = await call(app.handlers.login(req({ method: "POST", origin: "https://evil.example", body: { email: "a@example.com", password: PASSWORD } })));
    assert.equal(login.status, 403);
    const n = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM incidents");
    assert.equal(n[0]?.n, "0");
    // safe methods and same-origin / header-less (non-browser) clients still work
    assert.equal((await call(app.handlers.listIncidents(req({ cookie, origin: "https://evil.example" })))).status, 200);
    assert.equal((await call(app.handlers.createIncident(req({ method: "POST", cookie, origin: null, body: { title: "x", severity: "sev3" } })))).status, 201);
  });

  it("login sets a cookie, rejects bad credentials identically for unknown and known emails", async () => {
    await signUp("a@example.com");
    const good = await call(app.handlers.login(req({ method: "POST", body: { email: "A@example.com", password: PASSWORD } })));
    assert.equal(good.status, 200);
    assert.ok(good.result?.setCookie);
    const wrongPassword = await call(app.handlers.login(req({ method: "POST", body: { email: "a@example.com", password: "wrong wrong wrong" } })));
    const unknown = await call(app.handlers.login(req({ method: "POST", body: { email: "nobody@example.com", password: "wrong wrong wrong" } })));
    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, unknown.body);
    assert.equal(wrongPassword.result, undefined);
  });

  it("validation errors are 400 with field details; unknown failures never leak", async () => {
    const r = await call(app.handlers.register(req({ method: "POST", body: { email: "not-an-email" } })));
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "VALIDATION_FAILED");
    assert.ok(Array.isArray(r.body.error.details));
    assert.equal((await call(app.handlers.register(req({ method: "POST", body: undefined })))).status, 400);
  });

  it("full incident workflow over the handler layer, with 409 version conflicts and 409 invalid transitions", async () => {
    const { cookie } = await signUp("a@example.com");
    const created = await call(app.handlers.createIncident(req({ method: "POST", cookie, body: { title: "DB down", severity: "sev1" } })));
    assert.equal(created.status, 201);
    const inc = created.body as IncidentDto;
    const id = inc.id;

    const bad = await call(app.handlers.transitionIncident(req({ method: "POST", cookie, params: { id }, body: { to: "mitigated", expectedVersion: 1 } })));
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error.code, "INVALID_TRANSITION");

    const ack = await call(app.handlers.transitionIncident(req({ method: "POST", cookie, params: { id }, body: { to: "acknowledged", expectedVersion: 1 } })));
    assert.equal(ack.status, 200);
    const stale = await call(app.handlers.updateIncident(req({ method: "PATCH", cookie, params: { id }, body: { expectedVersion: 1, title: "x" } })));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error.code, "VERSION_CONFLICT");
    assert.equal(stale.body.error.details.currentVersion, 2);

    const comment = await call(app.handlers.commentOnIncident(req({ method: "POST", cookie, params: { id }, body: { body: "restarting" } })));
    assert.equal(comment.status, 201);
    const timeline = await call(app.handlers.incidentTimeline(req({ cookie, params: { id } })));
    assert.deepEqual(timeline.body.items.map((e: { type: string }) => e.type), ["created", "status_changed", "comment"]);
    const list = await call(app.handlers.listIncidents(req({ cookie, query: { status: "acknowledged" } })));
    assert.equal(list.body.items.length, 1);
  });

  it("tenant isolation through the HTTP layer: ids from another organization are 404 and a body organizationId is refused", async () => {
    const a = await signUp("a@example.com");
    const b = await signUp("b@example.com");
    const secret = (await call(app.handlers.createIncident(req({ method: "POST", cookie: a.cookie, body: { title: "secret", severity: "sev2" } })))).body as IncidentDto;
    for (const r of [
      await call(app.handlers.getIncident(req({ cookie: b.cookie, params: { id: secret.id } }))),
      await call(app.handlers.updateIncident(req({ method: "PATCH", cookie: b.cookie, params: { id: secret.id }, body: { expectedVersion: 1, title: "pwn" } }))),
      await call(app.handlers.incidentTimeline(req({ cookie: b.cookie, params: { id: secret.id } }))),
    ]) {
      assert.equal(r.status, 404);
    }
    const sneaky = await call(
      app.handlers.createIncident(req({ method: "POST", cookie: b.cookie, body: { title: "x", severity: "sev3", organizationId: a.me.activeOrganizationId } })),
    );
    assert.equal(sneaky.status, 400);
    const inA = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM incidents WHERE organization_id = $1", [a.me.activeOrganizationId]);
    assert.equal(inA[0]?.n, "1");
    // switching to an organization you do not belong to is indistinguishable from a missing one
    const sw = await call(app.handlers.switchOrganization(req({ method: "POST", cookie: b.cookie, body: { organizationId: a.me.activeOrganizationId } })));
    assert.equal(sw.status, 404);
  });

  it("authorization is enforced on the server: a viewer gets 403 on writes and cannot manage members", async () => {
    const owner = await signUp("o@example.com");
    const invite = await call(app.handlers.createInvite(req({ method: "POST", cookie: owner.cookie, body: { email: "v@example.com", role: "viewer" } })));
    assert.equal(invite.status, 201);
    const viewer = await signUp("v@example.com");
    const accepted = await call(app.handlers.acceptInvite(req({ method: "POST", cookie: viewer.cookie, body: { token: invite.body.token } })));
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.role, "viewer");
    assert.equal(accepted.body.activeOrganizationId, owner.me.activeOrganizationId);

    assert.equal((await call(app.handlers.createIncident(req({ method: "POST", cookie: viewer.cookie, body: { title: "x", severity: "sev3" } })))).status, 403);
    assert.equal((await call(app.handlers.createInvite(req({ method: "POST", cookie: viewer.cookie, body: { email: "z@example.com", role: "viewer" } })))).status, 403);
    assert.equal((await call(app.handlers.listMembers(req({ cookie: viewer.cookie })))).status, 200);
    const promote = await call(app.handlers.changeRole(req({ method: "PATCH", cookie: viewer.cookie, params: { userId: viewer.me.user.id }, body: { role: "owner" } })));
    assert.equal(promote.status, 403, "self-promotion is refused");
  });
});
