import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, type TestDatabase } from "../../test-support/session-factory";
import { runMigrations } from "./runner";
import { MigrationError } from "./types";

async function failureCode(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof MigrationError ? error.code : `other:${(error as Error).message}`;
  }
  return "no error";
}

describe("migration runner (real PostgreSQL)", () => {
  let db: TestDatabase;
  let dir: string;

  const write = (filename: string, sql: string) => writeFileSync(path.join(dir, filename), sql);
  const run = (mode: "apply" | "check" = "apply", extra: { lockTimeoutMs?: number } = {}) =>
    runMigrations(db.connect, { mode, directory: dir, lockPollMs: 20, ...extra });
  const tableExists = async (name: string) =>
    (await db.query<{ t: string | null }>("SELECT to_regclass($1)::text AS t", [name]))[0]?.t != null;
  const history = () => db.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");

  beforeEach(async () => {
    db = await createTestDatabase();
    dir = mkdtempSync(path.join(os.tmpdir(), "mig-int-"));
  });
  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db.drop();
  });

  it("applies pending migrations in version order and records them", async () => {
    write("0002_second.sql", "CREATE TABLE second (id int REFERENCES first (id));");
    write("0001_first.sql", "CREATE TABLE first (id int PRIMARY KEY);");
    const result = await run();
    assert.deepEqual(result.applied, ["0001_first.sql", "0002_second.sql"]);
    assert.deepEqual((await history()).map((r) => r.version), ["0001", "0002"]);
  });

  it("is idempotent: a second run applies nothing", async () => {
    write("0001_first.sql", "CREATE TABLE first (id int);");
    await run();
    const again = await run();
    assert.deepEqual(again.applied, []);
    assert.equal(again.alreadyApplied, 1);
  });

  it("rolls a failing migration back completely and keeps earlier ones", async () => {
    write("0001_ok.sql", "CREATE TABLE ok_table (id int);");
    write("0002_bad.sql", "CREATE TABLE half_done (id int);\nINSERT INTO does_not_exist VALUES (1);");
    assert.equal(await failureCode(run()), "MIGRATION_FAILED");
    assert.equal(await tableExists("ok_table"), true);
    assert.equal(await tableExists("half_done"), false, "partial work of the failed migration must not survive");
    assert.deepEqual((await history()).map((r) => r.version), ["0001"]);
  });

  it("releases the lock after a failure so a corrected run succeeds", async () => {
    write("0001_bad.sql", "SELECT * FROM nope;");
    assert.equal(await failureCode(run()), "MIGRATION_FAILED");
    write("0001_bad.sql", "CREATE TABLE fixed (id int);");
    // The file changed but was never recorded as applied, so this is allowed.
    const result = await run("apply", { lockTimeoutMs: 500 });
    assert.deepEqual(result.applied, ["0001_bad.sql"]);
  });

  it("refuses to run when an applied migration was edited", async () => {
    write("0001_a.sql", "CREATE TABLE a (id int);");
    await run();
    write("0001_a.sql", "CREATE TABLE a (id int, extra int);");
    assert.equal(await failureCode(run()), "CHECKSUM_MISMATCH");
  });

  it("refuses to run when an applied migration file is missing", async () => {
    write("0001_a.sql", "CREATE TABLE a (id int);");
    write("0002_b.sql", "CREATE TABLE b (id int);");
    await run();
    rmSync(path.join(dir, "0001_a.sql"));
    assert.equal(await failureCode(run()), "MISSING_FILE");
  });

  it("refuses to run when an applied migration was renamed", async () => {
    write("0001_a.sql", "CREATE TABLE a (id int);");
    await run();
    rmSync(path.join(dir, "0001_a.sql"));
    write("0001_renamed.sql", "CREATE TABLE a (id int);");
    assert.equal(await failureCode(run()), "NAME_MISMATCH");
  });

  it("refuses a new migration numbered below an already applied one", async () => {
    write("0002_b.sql", "CREATE TABLE b (id int);");
    await run();
    write("0001_a.sql", "CREATE TABLE a (id int);");
    assert.equal(await failureCode(run()), "OUT_OF_ORDER");
    assert.equal(await tableExists("a"), false);
  });

  it("check mode reports pending migrations without applying them", async () => {
    write("0001_a.sql", "CREATE TABLE a (id int);");
    assert.equal(await failureCode(run("check")), "PENDING_MIGRATIONS");
    assert.equal(await tableExists("a"), false);
    assert.equal(await tableExists("schema_migrations"), false, "check mode must not create anything");
    await run();
    const ok = await run("check");
    assert.equal(ok.alreadyApplied, 1);
  });

  it("check mode also detects drift", async () => {
    write("0001_a.sql", "CREATE TABLE a (id int);");
    await run();
    write("0001_a.sql", "CREATE TABLE a (id bigint);");
    assert.equal(await failureCode(run("check")), "CHECKSUM_MISMATCH");
  });

  it("two runners started together apply each migration exactly once", async () => {
    write("0001_a.sql", "SELECT pg_sleep(0.4);\nCREATE TABLE a (id int);");
    write("0002_b.sql", "CREATE TABLE b (id int);");
    const results = await Promise.all([run(), run()]);
    const appliedTotal = results.flatMap((r) => r.applied);
    assert.deepEqual([...appliedTotal].sort(), ["0001_a.sql", "0002_b.sql"]);
    assert.deepEqual((await history()).map((r) => r.version), ["0001", "0002"]);
  });

  it("gives up with LOCK_TIMEOUT instead of waiting forever", async () => {
    write("0001_slow.sql", "SELECT pg_sleep(1.5);\nCREATE TABLE slow (id int);");
    const holder = run();
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await failureCode(run("apply", { lockTimeoutMs: 200 })), "LOCK_TIMEOUT");
    await holder;
    assert.equal(await tableExists("slow"), true);
  });

  it("supports a no-transaction migration (CREATE INDEX CONCURRENTLY)", async () => {
    write("0001_t.sql", "CREATE TABLE t (c int);");
    write("0002_idx.sql", "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY t_c_idx ON t (c);");
    const result = await run();
    assert.deepEqual(result.applied, ["0001_t.sql", "0002_idx.sql"]);
    assert.equal(await tableExists("t_c_idx"), true);
  });

  it("is not affected by CRLF line endings introduced after applying", async () => {
    write("0001_a.sql", "CREATE TABLE a (\n  id int\n);\n");
    await run();
    write("0001_a.sql", "CREATE TABLE a (\r\n  id int\r\n);\r\n");
    const again = await run();
    assert.deepEqual(again.applied, []);
  });
});
