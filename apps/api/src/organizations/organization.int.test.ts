import assert from "node:assert/strict";
import { AppError } from "../common/errors";
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

describe("organizations, invitations and roles (real PostgreSQL)", () => {
  let app: TestApp;
  beforeEach(async () => {
    app = await createTestApp();
  });
  afterEach(async () => {
    await app.close();
  });

  it("lists only members of the caller's own organization", async () => {
    const a = await app.register("owner-a@example.com");
    const b = await app.register("owner-b@example.com");
    await app.join(a, "viewer-a@example.com", "viewer");
    const membersA = await app.organizations.listMembers(a.auth);
    assert.deepEqual(membersA.map((m) => m.email).sort(), ["owner-a@example.com", "viewer-a@example.com"]);
    const membersB = await app.organizations.listMembers(b.auth);
    assert.deepEqual(membersB.map((m) => m.email), ["owner-b@example.com"]);
  });

  it("invites: only admins and owners may create them; the role 'owner' is not invitable", async () => {
    const owner = await app.register("o@example.com");
    const responder = await app.join(owner, "r@example.com", "responder");
    assert.equal((await appError(app.organizations.createInvite(responder.auth, { email: "x@example.com", role: "viewer" }))).code, "FORBIDDEN");
    assert.equal((await appError(app.organizations.createInvite(owner.auth, { email: "x@example.com", role: "owner" }))).code, "VALIDATION_FAILED");
    const invite = await app.organizations.createInvite(owner.auth, { email: "x@example.com", role: "viewer" });
    const stored = await app.testDb.query<{ token_hash: string }>("SELECT token_hash FROM organization_invites WHERE id = $1", [invite.id]);
    assert.notEqual(stored[0]?.token_hash, invite.token, "the invitation token is stored only as a hash");
  });

  it("an invitation is bound to the invited email: another account cannot redeem it", async () => {
    const owner = await app.register("o@example.com");
    const invite = await app.organizations.createInvite(owner.auth, { email: "invitee@example.com", role: "responder" });
    const stranger = await app.register("stranger@example.com");
    assert.equal((await appError(app.organizations.acceptInvite(stranger.auth, { token: invite.token }))).code, "NOT_FOUND");
    const invitee = await app.register("invitee@example.com");
    const result = await app.organizations.acceptInvite(invitee.auth, { token: invite.token });
    assert.equal(result.role, "responder");
  });

  it("an invitation is single use, even when redeemed twice in parallel", async () => {
    const owner = await app.register("o@example.com");
    const invite = await app.organizations.createInvite(owner.auth, { email: "i@example.com", role: "viewer" });
    const invitee = await app.register("i@example.com");
    const results = await Promise.allSettled([
      app.organizations.acceptInvite(invitee.auth, { token: invite.token }),
      app.organizations.acceptInvite(invitee.auth, { token: invite.token }),
      app.organizations.acceptInvite(invitee.auth, { token: invite.token }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const memberships = await app.testDb.query<{ n: string }>(
      "SELECT count(*) AS n FROM memberships WHERE user_id = $1 AND organization_id = $2",
      [invitee.me.user.id, owner.me.activeOrganizationId],
    );
    assert.equal(memberships[0]?.n, "1");
  });

  it("revoked and expired invitations cannot be redeemed", async () => {
    const owner = await app.register("o@example.com");
    const revoked = await app.organizations.createInvite(owner.auth, { email: "a@example.com", role: "viewer" });
    await app.organizations.revokeInvite(owner.auth, revoked.id);
    const a = await app.register("a@example.com");
    assert.equal((await appError(app.organizations.acceptInvite(a.auth, { token: revoked.token }))).code, "NOT_FOUND");

    const expired = await app.organizations.createInvite(owner.auth, { email: "a@example.com", role: "viewer" });
    await app.testDb.query("UPDATE organization_invites SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1", [expired.id]);
    assert.equal((await appError(app.organizations.acceptInvite(a.auth, { token: expired.token }))).code, "NOT_FOUND");
    assert.equal((await app.organizations.listInvites(owner.auth)).length, 0);
  });

  it("accepting an invitation switches the session's active organization, and the new role applies at once", async () => {
    const owner = await app.register("o@example.com");
    const member = await app.join(owner, "m@example.com", "admin");
    assert.equal(member.auth.organizationId, owner.me.activeOrganizationId);
    assert.equal(member.auth.role, "admin");
  });

  it("role changes follow the permission matrix and are enforced server-side", async () => {
    const owner = await app.register("o@example.com");
    const admin = await app.join(owner, "ad@example.com", "admin");
    const viewer = await app.join(owner, "v@example.com", "viewer");
    const ownerId = owner.me.user.id;

    // a viewer cannot manage roles at all
    assert.equal((await appError(app.organizations.changeRole(viewer.auth, admin.me.user.id, { role: "viewer" }))).code, "FORBIDDEN");
    // an admin cannot touch the owner, promote to owner, or change their own role
    assert.equal((await appError(app.organizations.changeRole(admin.auth, ownerId, { role: "viewer" }))).code, "FORBIDDEN");
    assert.equal((await appError(app.organizations.changeRole(admin.auth, viewer.me.user.id, { role: "owner" }))).code, "FORBIDDEN");
    assert.equal((await appError(app.organizations.changeRole(admin.auth, admin.me.user.id, { role: "viewer" }))).code, "FORBIDDEN");
    // an admin can promote a viewer to responder
    const changed = await app.organizations.changeRole(admin.auth, viewer.me.user.id, { role: "responder" });
    assert.equal(changed.role, "responder");
    // the new role is effective on the very next request (role is read live, not cached in the session)
    const refreshed = await app.auth.authenticate(viewer.token);
    assert.equal(refreshed?.role, "responder");
  });

  it("the last owner cannot be demoted, removed or left behind", async () => {
    const owner = await app.register("o@example.com");
    assert.equal((await appError(app.organizations.changeRole(owner.auth, owner.me.user.id, { role: "admin" }))).code, "FORBIDDEN");
    // owners may remove themselves in principle; the database invariant refuses it when they are the last owner.
    // If they have assigned incidents, the entire removal (including unassignments/events) must roll back.
    const selfAssigned = await app.incidents.create(owner.auth, {
      title: "Owner assigned incident",
      description: "",
      severity: "sev2",
      assigneeId: owner.me.user.id,
    });
    const timelineBefore = await app.incidents.timeline(owner.auth, selfAssigned.id, {});
    assert.equal((await appError(app.organizations.removeMember(owner.auth, owner.me.user.id))).code, "CONFLICT");
    const afterFailedRemoval = await app.incidents.get(owner.auth, selfAssigned.id);
    const timelineAfter = await app.incidents.timeline(owner.auth, selfAssigned.id, {});
    assert.equal(afterFailedRemoval.assignee?.id, owner.me.user.id);
    assert.deepEqual(timelineAfter, timelineBefore, "a rejected owner removal must not leave unassignment/audit side effects");
    // with a second owner the first may be demoted by the second, but never the last one (DB-enforced)
    const second = await app.join(owner, "o2@example.com", "admin");
    await app.organizations.changeRole(owner.auth, second.me.user.id, { role: "owner" });
    await app.organizations.changeRole((await app.auth.authenticate(second.token)) as typeof second.auth, owner.me.user.id, { role: "admin" });
    const owners = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE role = 'owner' AND organization_id = $1", [owner.me.activeOrganizationId]);
    assert.equal(owners[0]?.n, "1");
  });

  it("two owners demoting each other at the same time can never leave zero owners", async () => {
    const o1 = await app.register("o1@example.com");
    const o2 = await app.join(o1, "o2@example.com", "admin");
    await app.organizations.changeRole(o1.auth, o2.me.user.id, { role: "owner" });
    const c1 = (await app.auth.authenticate(o1.token)) as typeof o1.auth;
    const c2 = (await app.auth.authenticate(o2.token)) as typeof o2.auth;
    await Promise.allSettled([
      app.organizations.changeRole(c1, o2.me.user.id, { role: "admin" }),
      app.organizations.changeRole(c2, o1.me.user.id, { role: "admin" }),
    ]);
    const owners = await app.testDb.query<{ n: string }>("SELECT count(*) AS n FROM memberships WHERE role = 'owner' AND organization_id = $1", [o1.me.activeOrganizationId]);
    assert.ok(Number(owners[0]?.n) >= 1, "at least one owner must remain");
  });

  it("member removal atomically unassigns their incidents and appends timeline events", async () => {
    const owner = await app.register("owner-audit@example.com");
    const member = await app.join(owner, "assigned-audit@example.com", "responder");
    const incident = await app.incidents.create(owner.auth, { title: "Assigned incident", description: "", severity: "sev2" });
    const assigned = await app.incidents.update(owner.auth, incident.id, {
      expectedVersion: incident.version,
      assigneeId: member.me.user.id,
    });
    assert.equal(assigned.assignee?.id, member.me.user.id);

    await app.organizations.removeMember(owner.auth, member.me.user.id);

    const after = await app.incidents.get(owner.auth, incident.id);
    assert.equal(after.assignee, null);
    assert.equal(after.version, assigned.version + 1, "the unassignment participates in optimistic concurrency");
    const timeline = await app.incidents.timeline(owner.auth, incident.id, {});
    const event = timeline[timeline.length - 1];
    assert.equal(event?.type, "assigned");
    assert.deepEqual(event?.payload, {
      from: { id: member.me.user.id, displayName: member.me.user.displayName },
      to: null,
      reason: "member_removed",
    });
    assert.equal(event?.actor.id, owner.me.user.id);
    assert.equal(event?.actor.label, owner.me.user.displayName);
  });

  it("member removal unassigns every incident of that member, with one audit event each, and leaves others alone", async () => {
    const owner = await app.register("o@example.com");
    const gone = await app.join(owner, "gone@example.com", "responder");
    const stays = await app.join(owner, "stays@example.com", "responder");
    const mine = await Promise.all(
      [1, 2, 3].map((i) => app.incidents.create(owner.auth, { title: `g${i}`, description: "", severity: "sev3", assigneeId: gone.me.user.id })),
    );
    const other = await app.incidents.create(owner.auth, { title: "s", description: "", severity: "sev3", assigneeId: stays.me.user.id });
    await app.organizations.removeMember(owner.auth, gone.me.user.id);
    for (const inc of mine) {
      assert.equal((await app.incidents.get(owner.auth, inc.id)).assignee, null);
      const events = (await app.incidents.timeline(owner.auth, inc.id, {})).filter((e) => e.type === "assigned");
      assert.equal(events.length, 2, "assigned + unassigned");
      assert.equal((events[1]?.payload as { reason?: string }).reason, "member_removed");
    }
    assert.equal((await app.incidents.get(owner.auth, other.id)).assignee?.id, stays.me.user.id);
    assert.equal((await app.incidents.timeline(owner.auth, other.id, {})).filter((e) => e.type === "assigned").length, 1);
  });

  it("race: assigning an incident while its assignee-to-be is removed never changes assignment without an audit event", async () => {
    // Invariant checked after every round: replaying the 'assigned' events gives exactly the stored assignee,
    // so no state change (such as a silent FK ON DELETE SET NULL) can happen outside the timeline.
    for (let round = 0; round < 12; round++) {
      const owner = await app.register(`race-owner-${round}@example.com`);
      const member = await app.join(owner, `race-member-${round}@example.com`, "responder");
      const incident = await app.incidents.create(owner.auth, { title: "race", description: "", severity: "sev3" });
      const viaUpdate = app.incidents.update(owner.auth, incident.id, { expectedVersion: 1, assigneeId: member.me.user.id });
      const viaCreate = app.incidents.create(owner.auth, { title: "race-create", description: "", severity: "sev3", assigneeId: member.me.user.id });
      const removal = app.organizations.removeMember(owner.auth, member.me.user.id);
      await Promise.allSettled([viaUpdate, viaCreate, removal]);

      const rows = await app.testDb.query<{ id: string; assignee_id: string | null }>(
        "SELECT id, assignee_id FROM incidents WHERE organization_id = $1",
        [owner.me.activeOrganizationId],
      );
      for (const row of rows) {
        const events = (await app.incidents.timeline(owner.auth, row.id, { limit: "200" })).filter((e) => e.type === "assigned");
        const replayed = events.length === 0 ? null : ((events[events.length - 1]?.payload as { to: { id: string } | null }).to?.id ?? null);
        assert.equal(row.assignee_id, replayed, `round ${round}: stored assignee must equal the audited one`);
        assert.equal(row.assignee_id, null, `round ${round}: a removed member must not remain assigned`);
      }
    }
  });

  it("removing a member revokes their access to that organization immediately", async () => {
    const owner = await app.register("o@example.com");
    const member = await app.join(owner, "m@example.com", "responder");
    await app.organizations.removeMember(owner.auth, member.me.user.id);
    const ctx = await app.auth.authenticate(member.token);
    assert.notEqual(ctx?.organizationId, owner.me.activeOrganizationId, "the session no longer points at the organization");
    assert.equal((await appError(app.organizations.removeMember(owner.auth, member.me.user.id))).code, "NOT_FOUND");
  });

  it("cross-tenant: user ids from another organization are 'not found', never actionable", async () => {
    const a = await app.register("a@example.com");
    const b = await app.register("b@example.com");
    assert.equal((await appError(app.organizations.changeRole(a.auth, b.me.user.id, { role: "viewer" }))).code, "NOT_FOUND");
    assert.equal((await appError(app.organizations.removeMember(a.auth, b.me.user.id))).code, "NOT_FOUND");
    assert.equal((await appError(app.organizations.revokeInvite(a.auth, "00000000-0000-4000-8000-000000000000"))).code, "NOT_FOUND");
    const inviteB = await app.organizations.createInvite(b.auth, { email: "z@example.com", role: "viewer" });
    assert.equal((await appError(app.organizations.revokeInvite(a.auth, inviteB.id))).code, "NOT_FOUND");
    assert.equal((await app.organizations.listInvites(b.auth)).length, 1, "B's invitation is untouched");
  });

  it("an invited user logs in with a password and holds the invited role next to their own personal organization", async () => {
    const owner = await app.register("o@example.com");
    await app.join(owner, "m@example.com", "viewer");
    const login = await app.auth.login({ email: "m@example.com", password: PASSWORD }, { ip: "198.51.100.9" });
    const membership = login.me.memberships.find((m) => m.organizationId === owner.me.activeOrganizationId);
    assert.equal(membership?.role, "viewer");
  });
});
