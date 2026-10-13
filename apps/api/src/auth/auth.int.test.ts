import assert from "node:assert/strict";
import { AppError } from "../common/errors";
import { hashToken } from "./tokens";
import { PASSWORD, createTestApp, type TestApp } from "../test-support/app-harness";

async function appError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected the call to fail");
}

const meta = { ip: "198.51.100.7" };

describe("authentication (real PostgreSQL)", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp({ limits: { loginAccount: 5, loginIp: 50, registerIp: 3 } });
  });
  afterEach(async () => {
    await app.close();
  });

  it("register creates the user, an organization with that user as owner, and a session, atomically", async () => {
    const result = await app.auth.register(
      { email: "  Ada@Example.COM ", password: PASSWORD, displayName: "Ada", organizationName: "Analytical Engines" },
      meta,
    );
    assert.equal(result.me.user.email, "ada@example.com", "email is stored normalised");
    assert.equal(result.me.memberships.length, 1);
    assert.equal(result.me.role, "owner");
    assert.equal(result.me.activeOrganizationId, result.me.memberships[0]?.organizationId);
    const ctx = await app.auth.authenticate(result.token);
    assert.equal(ctx?.role, "owner");
  });

  it("registering through an invitation joins the existing organization without creating a throwaway organization", async () => {
    const owner = await app.register("owner-invite@example.com", "Real organization");
    const invite = await app.organizations.createInvite(owner.auth, { email: "new-invitee@example.com", role: "responder" });
    const before = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM organizations");

    const registered = await app.auth.registerWithInvite(
      { email: " NEW-INVITEE@example.com ", password: PASSWORD, displayName: "New Invitee", inviteToken: invite.token },
      meta,
    );

    assert.equal(registered.me.user.email, "new-invitee@example.com");
    assert.equal(registered.me.memberships.length, 1);
    assert.equal(registered.me.activeOrganizationId, owner.me.activeOrganizationId);
    assert.equal(registered.me.role, "responder");
    assert.equal((await app.auth.authenticate(registered.token))?.organizationId, owner.me.activeOrganizationId);
    const after = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM organizations");
    assert.equal(after[0]?.n, before[0]?.n, "invite registration must not create a personal organization");
    const consumed = await app.testDb.query<{ accepted_by: string | null }>("SELECT accepted_by FROM organization_invites WHERE id = $1", [invite.id]);
    assert.equal(consumed[0]?.accepted_by, registered.me.user.id);
  });

  it("invite registration rejects a mismatched email without creating a user or consuming the invite", async () => {
    const owner = await app.register("owner-invite@example.com");
    const invite = await app.organizations.createInvite(owner.auth, { email: "intended@example.com", role: "viewer" });
    const before = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM users");
    const error = await appError(
      app.auth.registerWithInvite(
        { email: "wrong@example.com", password: PASSWORD, displayName: "Wrong", inviteToken: invite.token },
        meta,
      ),
    );
    assert.equal(error.code, "NOT_FOUND");
    assert.equal((await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM users"))[0]?.n, before[0]?.n);
    assert.equal((await app.testDb.query<{ accepted_at: string | null }>("SELECT accepted_at FROM organization_invites WHERE id = $1", [invite.id]))[0]?.accepted_at, null);
  });

  it("does not consume an invitation when its email already has an account; that account can sign in and accept it", async () => {
    const owner = await app.register("owner-existing-invite@example.com");
    const invite = await app.organizations.createInvite(owner.auth, { email: "existing-invitee@example.com", role: "viewer" });
    const existing = await app.register("existing-invitee@example.com");

    const error = await appError(
      app.auth.registerWithInvite(
        { email: "existing-invitee@example.com", password: PASSWORD, displayName: "Existing", inviteToken: invite.token },
        meta,
      ),
    );
    assert.equal(error.code, "CONFLICT");
    assert.equal((await app.testDb.query<{ accepted_at: string | null }>("SELECT accepted_at FROM organization_invites WHERE id = $1", [invite.id]))[0]?.accepted_at, null);

    const accepted = await app.organizations.acceptInvite(existing.auth, { token: invite.token });
    assert.equal(accepted.organizationId, owner.me.activeOrganizationId);
    assert.equal(accepted.role, "viewer");
  });

  it("an invitation can create exactly one account even when redeemed in parallel", async () => {
    const owner = await app.register("owner-parallel@example.com");
    const invite = await app.organizations.createInvite(owner.auth, { email: "parallel@example.com", role: "viewer" });
    const attempt = () =>
      app.auth.registerWithInvite({ email: "parallel@example.com", password: PASSWORD, displayName: "P", inviteToken: invite.token }, { ip: "198.51.100.30" });
    const results = await Promise.allSettled([attempt(), attempt(), attempt()]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.ok(["NOT_FOUND", "CONFLICT"].includes((r.reason as AppError).code));
    const users = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM users WHERE email = 'parallel@example.com'");
    assert.equal(users[0]?.n, "1");
    const memberships = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE organization_id = $1", [owner.me.activeOrganizationId]);
    assert.equal(memberships[0]?.n, "2");
  });

  it("revoked and expired invitations cannot be used to register, and nothing is created", async () => {
    const owner = await app.register("owner-dead-invites@example.com");
    const revoked = await app.organizations.createInvite(owner.auth, { email: "r@example.com", role: "viewer" });
    await app.organizations.revokeInvite(owner.auth, revoked.id);
    const expired = await app.organizations.createInvite(owner.auth, { email: "e@example.com", role: "viewer" });
    await app.testDb.query("UPDATE organization_invites SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1", [expired.id]);
    const before = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM users");
    for (const [email, token] of [["r@example.com", revoked.token], ["e@example.com", expired.token], ["r@example.com", "x".repeat(40)]] as const) {
      const err = await appError(app.auth.registerWithInvite({ email, password: PASSWORD, displayName: "X", inviteToken: token }, meta));
      assert.equal(err.code, "NOT_FOUND");
    }
    assert.equal((await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM users"))[0]?.n, before[0]?.n);
  });

  it("never stores the password or the session token in the clear", async () => {
    const { token } = await app.auth.register(
      { email: "a@example.com", password: PASSWORD, displayName: "A", organizationName: "Org" },
      meta,
    );
    const users = await app.testDb.query<{ password_hash: string }>("SELECT password_hash FROM users");
    assert.ok(users[0]?.password_hash.startsWith("scrypt$"));
    assert.ok(!users[0]?.password_hash.includes(PASSWORD));
    const sessions = await app.testDb.query<{ token_hash: string }>("SELECT token_hash FROM auth_sessions");
    assert.equal(sessions[0]?.token_hash, hashToken(token));
    assert.notEqual(sessions[0]?.token_hash, token);
  });

  it("rolls everything back when registration fails part-way (duplicate email leaves no orphan organization)", async () => {
    await app.register("dup@example.com");
    const before = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM organizations");
    const err = await appError(
      app.auth.register({ email: "DUP@example.com", password: PASSWORD, displayName: "B", organizationName: "Second" }, meta),
    );
    assert.equal(err.code, "CONFLICT");
    const after = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM organizations");
    assert.equal(after[0]?.n, before[0]?.n);
  });

  it("rejects invalid registration input without touching the database", async () => {
    for (const bad of [
      { email: "not-an-email", password: PASSWORD, displayName: "A", organizationName: "O" },
      { email: "a@example.com", password: "short", displayName: "A", organizationName: "O" },
      { email: "a@example.com", password: PASSWORD, displayName: "", organizationName: "O" },
      { email: "a@example.com", password: PASSWORD, displayName: "A", organizationName: "O", role: "owner" },
    ]) {
      assert.equal((await appError(app.auth.register(bad, meta))).code, "VALIDATION_FAILED");
    }
    const users = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM users");
    assert.equal(users[0]?.n, "0");
  });

  it("login succeeds with the right password and fails identically for unknown email and wrong password", async () => {
    await app.register("known@example.com");
    const ok = await app.auth.login({ email: "KNOWN@example.com", password: PASSWORD }, meta);
    assert.equal(ok.me.user.email, "known@example.com");
    assert.ok(await app.auth.authenticate(ok.token));

    const wrong = await appError(app.auth.login({ email: "known@example.com", password: "wrong password 123" }, meta));
    const unknown = await appError(app.auth.login({ email: "nobody@example.com", password: "wrong password 123" }, meta));
    assert.equal(wrong.code, "UNAUTHENTICATED");
    assert.equal(wrong.message, unknown.message, "the message must not reveal whether the account exists");
    assert.equal(wrong.status, unknown.status);
  });

  it("a disabled user cannot log in, and an existing session stops working", async () => {
    const user = await app.register("off@example.com");
    await app.testDb.query("UPDATE users SET disabled_at = now() WHERE email = 'off@example.com'");
    assert.equal(await app.auth.authenticate(user.token), null);
    assert.equal((await appError(app.auth.login({ email: "off@example.com", password: PASSWORD }, meta))).code, "UNAUTHENTICATED");
  });

  it("logout revokes the session server-side (the token itself is useless afterwards)", async () => {
    const user = await app.register("out@example.com");
    assert.ok(await app.auth.authenticate(user.token));
    await app.auth.logout(user.auth);
    assert.equal(await app.auth.authenticate(user.token), null);
  });

  it("an expired session is rejected", async () => {
    const user = await app.register("old@example.com");
    await app.testDb.query("UPDATE auth_sessions SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'");
    assert.equal(await app.auth.authenticate(user.token), null);
  });

  it("rejects missing, garbage and oversized tokens without errors", async () => {
    for (const token of [undefined, "", "nope", "x".repeat(500)]) assert.equal(await app.auth.authenticate(token), null);
  });

  it("throttles repeated failures per account+IP, even when the correct password is then supplied", async () => {
    await app.register("victim@example.com");
    for (let i = 0; i < 5; i++) {
      assert.equal((await appError(app.auth.login({ email: "victim@example.com", password: `guess number ${i}` }, meta))).code, "UNAUTHENTICATED");
    }
    const blocked = await appError(app.auth.login({ email: "victim@example.com", password: PASSWORD }, meta));
    assert.equal(blocked.code, "RATE_LIMITED");
    assert.ok(Number(blocked.headers?.["Retry-After"]) >= 1);
  });

  it("an attacker's failures from one address do not lock the real user out from another address", async () => {
    await app.register("victim@example.com");
    for (let i = 0; i < 6; i++) await app.auth.login({ email: "victim@example.com", password: `guess ${i}` }, { ip: "192.0.2.66" }).catch(() => undefined);
    const real = await app.auth.login({ email: "victim@example.com", password: PASSWORD }, { ip: "203.0.113.50" });
    assert.ok(await app.auth.authenticate(real.token));
  });

  it("a successful login clears the account's failure count", async () => {
    await app.register("typo@example.com");
    for (let i = 0; i < 4; i++) await app.auth.login({ email: "typo@example.com", password: `oops ${i}` }, meta).catch(() => undefined);
    await app.auth.login({ email: "typo@example.com", password: PASSWORD }, meta);
    for (let i = 0; i < 4; i++) {
      assert.equal((await appError(app.auth.login({ email: "typo@example.com", password: `again ${i}` }, meta))).code, "UNAUTHENTICATED");
    }
  });

  it("throttles registrations per IP", async () => {
    for (let i = 0; i < 3; i++) await app.register(`user${i}@example.com`);
    // app.register uses a fixed IP; the 4th from the same address is refused
    const err = await appError(app.register("user3@example.com"));
    assert.equal(err.code, "RATE_LIMITED");
  });

  it("role changes apply to the very next request (role is read from the live membership, not cached in the session)", async () => {
    const owner = await app.register("owner@example.com");
    const member = await app.join(owner, "member@example.com", "admin");
    assert.equal((await app.auth.authenticate(member.token))?.role, "admin");
    await app.testDb.query("UPDATE memberships SET role = 'viewer' WHERE user_id = $1 AND role = 'admin'", [member.auth.userId]);
    assert.equal((await app.auth.authenticate(member.token))?.role, "viewer");
  });

  it("switching organization works only for the caller's own memberships", async () => {
    const a = await app.register("a@example.com", "Org A");
    const b = await app.register("b@example.com", "Org B");
    const bOrg = b.me.activeOrganizationId as string;
    assert.equal((await appError(app.auth.switchOrganization(a.auth, bOrg))).code, "NOT_FOUND");
    const own = await app.auth.switchOrganization(a.auth, a.me.activeOrganizationId as string);
    assert.equal(own.activeOrganizationId, a.me.activeOrganizationId);
  });

  it("the database itself refuses an active organization the user is not a member of", async () => {
    const a = await app.register("a@example.com", "Org A");
    const b = await app.register("b@example.com", "Org B");
    await assert.rejects(
      app.testDb.query("UPDATE auth_sessions SET organization_id = $1 WHERE id = $2", [b.me.activeOrganizationId, a.auth.sessionId]),
      (e: { code?: string }) => e.code === "23503",
    );
  });

  it("removing a membership clears that session's active organization instead of leaving a dangling one", async () => {
    const owner = await app.register("owner@example.com");
    const member = await app.join(owner, "m@example.com", "responder");
    await app.organizations.removeMember(owner.auth, member.auth.userId);
    const after = await app.auth.authenticate(member.token);
    assert.equal(after?.organizationId, null);
    assert.equal(after?.role, null);
  });
});
