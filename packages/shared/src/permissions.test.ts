import assert from "node:assert/strict";
import { ACTION_MIN_ROLE, canChangeRole, canRemoveMember, can } from "./permissions";
import { ORG_ROLES } from "./roles";

describe("action permissions", () => {
  it("viewers read only; responders work incidents; admins manage members", () => {
    assert.equal(can("viewer", "incident:read"), true);
    assert.equal(can("viewer", "incident:create"), false);
    assert.equal(can("viewer", "incident:comment"), false);
    assert.equal(can("responder", "incident:transition"), true);
    assert.equal(can("responder", "member:invite"), false);
    assert.equal(can("admin", "member:invite"), true);
    assert.equal(can("owner", "member:setRole"), true);
  });

  it("only admins and owners manage integration credentials", () => {
    assert.equal(can("viewer", "integration:manage"), false);
    assert.equal(can("responder", "integration:manage"), false);
    assert.equal(can("admin", "integration:manage"), true);
    assert.equal(can("owner", "integration:manage"), true);
  });

  it("AI suggestions: responders use them, only admins and owners switch them on", () => {
    assert.equal(can("viewer", "aiSuggestion:use"), false);
    assert.equal(can("responder", "aiSuggestion:use"), true);
    assert.equal(can("responder", "ai:configure"), false);
    assert.equal(can("admin", "ai:configure"), true);
    assert.equal(can("owner", "ai:configure"), true);
  });

  it("no role means no permission", () => {
    assert.equal(can(null, "incident:read"), false);
    assert.equal(can(undefined, "incident:read"), false);
  });

  it("permissions only ever grow with the role (monotonic)", () => {
    for (const action of Object.keys(ACTION_MIN_ROLE) as Array<keyof typeof ACTION_MIN_ROLE>) {
      let allowed = false;
      for (const role of ORG_ROLES) {
        const now = can(role, action);
        assert.ok(!allowed || now, `${action}: ${role} lost a permission a lower role had`);
        allowed = now;
      }
    }
  });
});

describe("role changes", () => {
  const base = { actorIsTarget: false };

  it("owners can change anyone, including promoting to owner", () => {
    assert.equal(canChangeRole({ ...base, actorRole: "owner", targetRole: "admin", newRole: "owner" }), true);
    assert.equal(canChangeRole({ ...base, actorRole: "owner", targetRole: "owner", newRole: "admin" }), true);
  });

  it("admins move non-owners between viewer/responder/admin only", () => {
    assert.equal(canChangeRole({ ...base, actorRole: "admin", targetRole: "viewer", newRole: "admin" }), true);
    assert.equal(canChangeRole({ ...base, actorRole: "admin", targetRole: "viewer", newRole: "owner" }), false);
    assert.equal(canChangeRole({ ...base, actorRole: "admin", targetRole: "owner", newRole: "admin" }), false);
  });

  it("nobody changes their own role, and lower roles cannot change anything", () => {
    assert.equal(canChangeRole({ actorRole: "owner", actorIsTarget: true, targetRole: "owner", newRole: "admin" }), false);
    assert.equal(canChangeRole({ actorRole: "admin", actorIsTarget: true, targetRole: "admin", newRole: "owner" }), false);
    assert.equal(canChangeRole({ ...base, actorRole: "responder", targetRole: "viewer", newRole: "responder" }), false);
  });

  it("removal: admins cannot remove owners or themselves; owners can remove anyone", () => {
    assert.equal(canRemoveMember({ ...base, actorRole: "admin", targetRole: "responder" }), true);
    assert.equal(canRemoveMember({ ...base, actorRole: "admin", targetRole: "owner" }), false);
    assert.equal(canRemoveMember({ actorRole: "admin", actorIsTarget: true, targetRole: "admin" }), false);
    assert.equal(canRemoveMember({ ...base, actorRole: "owner", targetRole: "owner" }), true);
    assert.equal(canRemoveMember({ ...base, actorRole: "responder", targetRole: "viewer" }), false);
  });
});

describe("analysis permissions", () => {
  it("responders and above may request an analysis; viewers may not", () => {
    assert.equal(can("viewer", "analysis:request"), false);
    assert.equal(can("responder", "analysis:request"), true);
  });
});
