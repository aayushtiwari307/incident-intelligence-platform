import assert from "node:assert/strict";
import { ORG_ROLES, orgRoleSchema, roleAtLeast } from "./roles";

describe("roles", () => {
  it("orders roles from viewer to owner", () => {
    assert.deepEqual([...ORG_ROLES], ["viewer", "responder", "admin", "owner"]);
  });

  it("roleAtLeast is reflexive and monotonic", () => {
    for (const role of ORG_ROLES) assert.equal(roleAtLeast(role, role), true);
    assert.equal(roleAtLeast("owner", "viewer"), true);
    assert.equal(roleAtLeast("viewer", "owner"), false);
    assert.equal(roleAtLeast("responder", "admin"), false);
    assert.equal(roleAtLeast("admin", "responder"), true);
  });

  it("schema accepts known roles only", () => {
    assert.equal(orgRoleSchema.safeParse("admin").success, true);
    assert.equal(orgRoleSchema.safeParse("superuser").success, false);
    assert.equal(orgRoleSchema.safeParse("ADMIN").success, false);
    assert.equal(orgRoleSchema.safeParse(undefined).success, false);
  });
});
