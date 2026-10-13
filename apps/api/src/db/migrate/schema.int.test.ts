import assert from "node:assert/strict";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../test-support/session-factory";
import { runMigrations } from "./runner";

const A = "00000000-0000-0000-0000-0000000000a1";
const B = "00000000-0000-0000-0000-0000000000b1";
const ORG = "00000000-0000-0000-0000-00000000000a";
const HASH = "x".repeat(30);

/**
 * Runs statements in ONE transaction and returns the SQLSTATE of the first failure ("ok" if none).
 * Deferred constraints are forced to run before the transaction is rolled back, so nothing is ever
 * committed and tests cannot affect each other.
 */
async function sqlState(db: TestDatabase, statements: string[]): Promise<string> {
  const session = await db.connect();
  try {
    await session.query("BEGIN");
    try {
      for (const s of statements) await session.query(s);
      await session.query("SET CONSTRAINTS ALL IMMEDIATE");
      await session.query("ROLLBACK");
      return "ok";
    } catch (error) {
      await session.query("ROLLBACK");
      return (error as { code?: string }).code ?? "unknown";
    }
  } finally {
    await session.close();
  }
}

const user = (id: string, email: string) =>
  `INSERT INTO users (id, email, password_hash, display_name) VALUES ('${id}', '${email}', '${HASH}', 'U')`;
const org = `INSERT INTO organizations (id, slug, name) VALUES ('${ORG}', 'acme', 'Acme')`;
const member = (userId: string, role: string) => `INSERT INTO memberships VALUES ('${ORG}', '${userId}', '${role}')`;

describe("schema integrity (real PostgreSQL, real migrations)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await runMigrations(db.connect, { mode: "apply", directory: path.resolve(__dirname, "../../../migrations") });
  });
  afterAll(async () => {
    await db.drop();
  });

  it("accepts an organization created together with its first owner", async () => {
    assert.equal(await sqlState(db, [user(A, "a@example.com"), org, member(A, "owner")]), "ok");
  });

  it("rejects an organization with no owner at commit", async () => {
    assert.equal(await sqlState(db, [org]), "23514");
    assert.equal(await sqlState(db, [user(A, "a@example.com"), org, member(A, "admin")]), "23514");
  });

  it("rejects an invalid role", async () => {
    assert.equal(await sqlState(db, [user(A, "a@example.com"), org, member(A, "superuser")]), "23514");
  });

  it("rejects emails that are not stored normalised, and duplicates", async () => {
    assert.equal(await sqlState(db, [user(A, "Mixed@Example.com")]), "23514");
    assert.equal(await sqlState(db, [user(A, "a@example.com"), user(B, "a@example.com")]), "23505");
  });

  it("rejects a bad organization slug", async () => {
    for (const slug of ["Has Caps", "-lead", "trail-", "x".repeat(41)]) {
      const sql = `INSERT INTO organizations (slug, name) VALUES ('${slug}', 'N')`;
      assert.equal(await sqlState(db, [sql]), "23514", slug);
    }
  });

  it("rejects removing or demoting the last owner, but allows hand-over in one transaction", async () => {
    const setup = [user(A, "a@example.com"), user(B, "b@example.com"), org, member(A, "owner"), member(B, "admin")];
    assert.equal(await sqlState(db, [...setup, `DELETE FROM memberships WHERE user_id = '${A}'`]), "23514");
    assert.equal(await sqlState(db, [...setup, `UPDATE memberships SET role = 'admin' WHERE user_id = '${A}'`]), "23514");
    assert.equal(
      await sqlState(db, [
        ...setup,
        `UPDATE memberships SET role = 'owner' WHERE user_id = '${B}'`,
        `UPDATE memberships SET role = 'admin' WHERE user_id = '${A}'`,
      ]),
      "ok",
    );
  });

  it("rejects sessions that expire before they are created and unknown users", async () => {
    const base = [user(A, "a@example.com")];
    const past = `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ('${A}', repeat('a',64), now() - interval '1 minute')`;
    assert.equal(await sqlState(db, [...base, past]), "23514");
    const orphan = "INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES (gen_random_uuid(), repeat('b',64), now() + interval '1 hour')";
    assert.equal(await sqlState(db, [orphan]), "23503");
  });

  it("bumps updated_at on update (separate transactions: now() is fixed within one)", async () => {
    await db.query(user(A, "ts@example.com"));
    await new Promise((r) => setTimeout(r, 30));
    await db.query(`UPDATE users SET display_name = 'Renamed' WHERE id = '${A}'`);
    const [row] = await db.query<{ bumped: boolean }>(`SELECT updated_at > created_at AS bumped FROM users WHERE id = '${A}'`);
    assert.equal(row?.bumped, true);
    await db.query(`DELETE FROM users WHERE id = '${A}'`);
  });
});
