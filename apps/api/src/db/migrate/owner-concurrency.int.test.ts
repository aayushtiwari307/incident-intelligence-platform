import assert from "node:assert/strict";
import path from "node:path";
import type { MigrationSession } from "./types";
import { runMigrations } from "./runner";
import { createTestDatabase, type TestDatabase } from "../../test-support/session-factory";

const ORG = "00000000-0000-0000-0000-00000000000a";
const OTHER_ORG = "00000000-0000-0000-0000-00000000000b";
const user = (n: number) => `00000000-0000-0000-0000-0000000000${n.toString().padStart(2, "0")}`;
const U1 = user(1);
const U2 = user(2);
const U3 = user(3);

/** Creates users and one organization whose memberships are the given [user, role] pairs, committed. */
async function seedOrg(db: TestDatabase, orgId: string, slug: string, members: Array<[string, string]>) {
  const session = await db.connect();
  try {
    await session.query("BEGIN");
    for (const [id] of members) {
      await session.query(
        `INSERT INTO users (id, email, password_hash, display_name)
         VALUES ('${id}', '${id.slice(-2)}-${slug}@example.com', '${"x".repeat(30)}', 'U')
         ON CONFLICT DO NOTHING`,
      );
    }
    await session.query(`INSERT INTO organizations (id, slug, name) VALUES ('${orgId}', '${slug}', 'Org')`);
    for (const [id, role] of members) {
      await session.query(`INSERT INTO memberships VALUES ('${orgId}', '${id}', '${role}')`);
    }
    await session.query("COMMIT");
  } finally {
    await session.close();
  }
}

const owners = async (db: TestDatabase, orgId: string) =>
  (await db.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE organization_id = '${orgId}' AND role = 'owner' ORDER BY user_id`)).map(
    (r) => r.user_id,
  );

/** Resolves once the backend is waiting on a lock, so the test knows the second transaction really was serialised. */
async function waitUntilBlocked(db: TestDatabase, pid: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.query<{ wait_event_type: string | null }>("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [Number(pid)]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail("second transaction never blocked: owner-changing operations are not serialised per organization");
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown";
  }
}

describe("organization owner invariant under concurrency (real PostgreSQL)", () => {
  let db: TestDatabase;
  let s1: MigrationSession;
  let s2: MigrationSession;

  beforeEach(async () => {
    db = await createTestDatabase();
    await runMigrations(db.connect, { mode: "apply", directory: path.resolve(__dirname, "../../../migrations") });
    s1 = await db.connect();
    s2 = await db.connect();
  });
  afterEach(async () => {
    await s1.close();
    await s2.close();
    await db.drop();
  });

  /**
   * Runs the classic write-skew schedule: s1 performs `first` and holds its transaction open, s2 starts
   * `second` (which must block), s1 commits, then s2 tries to commit.
   */
  async function raceTwoOwnerChanges(first: string, second: string) {
    const pid2 = (await s2.query<{ pid: string }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid as string;
    await s1.query("BEGIN");
    await s1.query(first);
    await s2.query("BEGIN");
    const secondStatement = s2.query(second); // blocks behind s1
    await waitUntilBlocked(db, pid2);
    const firstCommit = await codeOf(s1.query("COMMIT"));
    await secondStatement;
    const secondCommit = await codeOf(s2.query("COMMIT"));
    if (secondCommit !== "ok") await s2.query("ROLLBACK");
    return { firstCommit, secondCommit };
  }

  it("two transactions demoting two different owners cannot leave the organization ownerless", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    const { firstCommit, secondCommit } = await raceTwoOwnerChanges(
      `UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`,
      `UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U2}'`,
    );
    assert.equal(firstCommit, "ok");
    assert.equal(secondCommit, "23514");
    assert.deepEqual(await owners(db, ORG), [U2]);
  });

  it("write skew: both owner checks pass while the other change is uncommitted (the 0001-only schema ends with zero owners)", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    const pid2 = (await s2.query<{ pid: string }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid as string;
    await s1.query("BEGIN");
    await s1.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`);
    // The owner check runs now, while U2 is still an owner: it passes.
    await s1.query("SET CONSTRAINTS ALL IMMEDIATE");
    await s2.query("BEGIN");
    const demote = s2.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U2}'`);
    await waitUntilBlocked(db, pid2); // without the fix this statement returns at once and its check also passes
    assert.equal(await codeOf(s1.query("COMMIT")), "ok");
    await demote;
    assert.equal(await codeOf(s2.query("SET CONSTRAINTS ALL IMMEDIATE")), "23514");
    await s2.query("ROLLBACK");
    assert.deepEqual(await owners(db, ORG), [U2]);
  });

  it("two transactions removing two different owners' memberships cannot leave the organization ownerless", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    const { firstCommit, secondCommit } = await raceTwoOwnerChanges(
      `DELETE FROM memberships WHERE organization_id = '${ORG}' AND user_id = '${U1}'`,
      `DELETE FROM memberships WHERE organization_id = '${ORG}' AND user_id = '${U2}'`,
    );
    assert.equal(firstCommit, "ok");
    assert.equal(secondCommit, "23514");
    assert.deepEqual(await owners(db, ORG), [U2]);
  });

  it("demoting one owner while deleting another owner's user account is also serialised", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    const { firstCommit, secondCommit } = await raceTwoOwnerChanges(
      `UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`,
      `DELETE FROM users WHERE id = '${U2}'`, // cascades to the membership
    );
    assert.equal(firstCommit, "ok");
    assert.equal(secondCommit, "23514");
    assert.deepEqual(await owners(db, ORG), [U2]);
  });

  it("a legitimate hand-over racing with a demotion still ends with an owner", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"], [U3, "admin"]]);
    // s1 promotes U3 and demotes U1; s2 then demotes U2. Serialised result: U3 is the only owner.
    const pid2 = (await s2.query<{ pid: string }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid as string;
    await s1.query("BEGIN");
    await s1.query(`UPDATE memberships SET role = 'owner' WHERE organization_id = '${ORG}' AND user_id = '${U3}'`);
    await s1.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`);
    await s2.query("BEGIN");
    const demote = s2.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U2}'`);
    await waitUntilBlocked(db, pid2);
    assert.equal(await codeOf(s1.query("COMMIT")), "ok");
    await demote;
    assert.equal(await codeOf(s2.query("COMMIT")), "ok");
    assert.deepEqual(await owners(db, ORG), [U3]);
  });

  it("if the first transaction rolls back, the waiting one proceeds and succeeds", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    const pid2 = (await s2.query<{ pid: string }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid as string;
    await s1.query("BEGIN");
    await s1.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`);
    await s2.query("BEGIN");
    const demote = s2.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U2}'`);
    await waitUntilBlocked(db, pid2);
    await s1.query("ROLLBACK");
    await demote;
    assert.equal(await codeOf(s2.query("COMMIT")), "ok");
    assert.deepEqual(await owners(db, ORG), [U1]);
  });

  it("organizations do not block each other", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    await seedOrg(db, OTHER_ORG, "globex", [[U1, "owner"], [U3, "owner"]]);
    await s1.query("BEGIN");
    await s1.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`);
    await s2.query("BEGIN");
    // Would hang forever if the lock were global; the test timeout would then fail it.
    await s2.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${OTHER_ORG}' AND user_id = '${U3}'`);
    assert.equal(await codeOf(s2.query("COMMIT")), "ok");
    assert.equal(await codeOf(s1.query("COMMIT")), "ok");
  });

  it("adding members is not blocked by a pending owner change", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    await seedOrg(db, OTHER_ORG, "globex", [[U3, "owner"]]);
    await s1.query("BEGIN");
    await s1.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`);
    await s2.query("BEGIN");
    await s2.query(`INSERT INTO memberships VALUES ('${ORG}', '${U3}', 'viewer')`);
    assert.equal(await codeOf(s2.query("COMMIT")), "ok");
    assert.equal(await codeOf(s1.query("COMMIT")), "ok");
  });

  it("refuses to remove an owner under REPEATABLE READ, where the commit-time check would use a stale snapshot", async () => {
    await seedOrg(db, ORG, "acme", [[U1, "owner"], [U2, "owner"]]);
    await s1.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const code = await codeOf(s1.query(`UPDATE memberships SET role = 'admin' WHERE organization_id = '${ORG}' AND user_id = '${U1}'`));
    await s1.query("ROLLBACK");
    assert.equal(code, "0A000");
  });
});
