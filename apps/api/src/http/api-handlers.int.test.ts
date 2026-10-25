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

  it("creates and updates a resolution through the incident HTTP handlers", async () => {
    const { cookie } = await signUp("resolution-handler@example.com");
    const createdIncident = await call(
      app.handlers.createIncident(req({ method: "POST", cookie, body: { title: "DB down", severity: "sev1" } })),
    );
    const incident = createdIncident.body as IncidentDto;

    const absent = await call(app.handlers.getIncidentResolution(req({ cookie, params: { id: incident.id } })));
    assert.equal(absent.status, 404);

    const created = await call(
      app.handlers.createIncidentResolution(
        req({ method: "POST", cookie, params: { id: incident.id }, body: { rootCause: "Pool saturation", fixApplied: "Increased capacity" } }),
      ),
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.version, 1);
    assert.equal(created.body.resolvedBy, ((await app.handlers.me(req({ cookie }))).body as MeDto).user.id);

    const read = await call(app.handlers.getIncidentResolution(req({ cookie, params: { id: incident.id } })));
    assert.equal(read.status, 200);
    assert.equal(read.body.rootCause, "Pool saturation");
    assert.equal(read.body.fixApplied, "Increased capacity");

    const updated = await call(
      app.handlers.updateIncidentResolution(
        req({
          method: "PUT",
          cookie,
          params: { id: incident.id },
          body: { expectedVersion: 1, rootCause: "Pool saturation after deploy", fixApplied: "Rolled back deploy" },
        }),
      ),
    );
    assert.equal(updated.status, 200);
    assert.equal(updated.body.version, 2);

    const forged = await call(
      app.handlers.updateIncidentResolution(
        req({ method: "PUT", cookie, params: { id: incident.id }, body: { expectedVersion: 2, rootCause: "x", fixApplied: "y", resolvedBy: "forged" } }),
      ),
    );
    assert.equal(forged.status, 400);
    assert.equal(forged.body.error.code, "VALIDATION_FAILED");
  });

  it("tenant isolation through the HTTP layer: ids from another organization are 404 and a body organizationId is refused", async () => {
    const a = await signUp("a@example.com");
    const b = await signUp("b@example.com");
    const secret = (await call(app.handlers.createIncident(req({ method: "POST", cookie: a.cookie, body: { title: "secret", severity: "sev2" } })))).body as IncidentDto;
    const resolution = await call(
      app.handlers.createIncidentResolution(
        req({ method: "POST", cookie: a.cookie, params: { id: secret.id }, body: { rootCause: "private cause", fixApplied: "private fix" } }),
      ),
    );
    assert.equal(resolution.status, 201);
    for (const r of [
      await call(app.handlers.getIncident(req({ cookie: b.cookie, params: { id: secret.id } }))),
      await call(app.handlers.getIncidentResolution(req({ cookie: b.cookie, params: { id: secret.id } }))),
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

describe("invite-only mode: public sign-up refused, invitations and sign-in intact (real PostgreSQL)", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp({ publicRegistrationEnabled: false });
  });
  afterEach(async () => {
    await app.close();
  });

  const count = async (table: "users" | "organizations" | "organization_invites"): Promise<number> =>
    Number((await app.testDb.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n);
  const inviteBody = (email: string, inviteToken: unknown) => ({ email, password: PASSWORD, displayName: "Invitee", inviteToken });
  const post = (body: unknown) => req({ method: "POST", body });

  it("advertises the policy to the sign-up page as a public, uncached response", async () => {
    const r = await call(Promise.resolve(app.handlers.registrationPolicy()));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { publicRegistration: false });
    assert.equal(r.result?.headers?.["Cache-Control"], "no-store");

    const open = await createTestApp();
    try {
      assert.deepEqual((await call(Promise.resolve(open.handlers.registrationPolicy()))).body, { publicRegistration: true });
    } finally {
      await open.close();
    }
  });

  it("refuses public registration whatever the body is, and creates nothing", async () => {
    const valid = { email: "public@example.com", password: PASSWORD, displayName: "P", organizationName: "P org" };
    for (const body of [undefined, {}, { email: "x" }, valid]) {
      const r = await call(app.handlers.register(post(body)));
      assert.equal(r.status, 403);
      assert.equal(r.body.error.code, "FORBIDDEN");
    }
    assert.equal(await count("users"), 0);
    assert.equal(await count("organizations"), 0);
  });

  it("still lets an existing user sign in", async () => {
    await app.register("returning@example.com");
    const r = await call(app.handlers.login(post({ email: "returning@example.com", password: PASSWORD })));
    assert.equal(r.status, 200);
    assert.ok(r.result?.setCookie, "a session cookie is issued");
    const bad = await call(app.handlers.login(post({ email: "returning@example.com", password: `${PASSWORD}x` })));
    assert.equal(bad.status, 401);
  });

  it("an invitation creates exactly one account; reusing it is refused and creates nothing", async () => {
    const owner = await app.register("owner@example.com");
    const invite = await app.organizations.createInvite(owner.auth, { email: "new@example.com", role: "viewer" });
    const first = await call(app.handlers.registerWithInvite(post(inviteBody("new@example.com", invite.token))));
    assert.equal(first.status, 201);
    const users = await count("users");
    const second = await call(app.handlers.registerWithInvite(post(inviteBody("new@example.com", invite.token))));
    assert.ok([404, 409].includes(second.status), `reuse must be refused, got ${second.status}`);
    assert.equal(await count("users"), users);
  });

  it("an invitation for another email address is refused and stays usable by its real recipient", async () => {
    const owner = await app.register("owner@example.com");
    const invite = await app.organizations.createInvite(owner.auth, { email: "intended@example.com", role: "viewer" });
    const users = await count("users");
    const wrong = await call(app.handlers.registerWithInvite(post(inviteBody("someone-else@example.com", invite.token))));
    assert.equal(wrong.status, 404);
    assert.equal(await count("users"), users);
    const right = await call(app.handlers.registerWithInvite(post(inviteBody("intended@example.com", invite.token))));
    assert.equal(right.status, 201);
  });

  it("expired and revoked invitations are refused", async () => {
    const owner = await app.register("owner@example.com");
    const expired = await app.organizations.createInvite(owner.auth, { email: "expired@example.com", role: "viewer" });
    await app.testDb.query("UPDATE organization_invites SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1", [expired.id]);
    const revoked = await app.organizations.createInvite(owner.auth, { email: "revoked@example.com", role: "viewer" });
    await app.organizations.revokeInvite(owner.auth, revoked.id);
    const users = await count("users");
    for (const [email, token] of [["expired@example.com", expired.token], ["revoked@example.com", revoked.token]] as const) {
      assert.equal((await call(app.handlers.registerWithInvite(post(inviteBody(email, token))))).status, 404, email);
    }
    assert.equal(await count("users"), users);
  });

  it("a missing, blank, short or non-string invitation token is a validation error and creates nothing", async () => {
    const users = await count("users");
    for (const token of [undefined, "", "   ", "short", 12345, null]) {
      const r = await call(app.handlers.registerWithInvite(post(inviteBody("nobody@example.com", token))));
      assert.equal(r.status, 400, `token ${JSON.stringify(token)}`);
      assert.equal(r.body.error.code, "VALIDATION_FAILED");
    }
    assert.equal(await count("users"), users);
  });

  it("a foreign Origin is refused before the policy is even consulted", async () => {
    const r = await call(app.handlers.register(req({ method: "POST", origin: "https://evil.example", body: {} })));
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, "ORIGIN_NOT_ALLOWED");
  });
});
