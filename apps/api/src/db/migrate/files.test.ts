import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { checksumOf, loadMigrationFiles, parseMigration } from "./files";
import { MigrationError } from "./types";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof MigrationError ? error.code : `other:${(error as Error).message}`;
  }
  return undefined;
}

describe("migration file parsing", () => {
  it("parses version, name and transactional default", () => {
    const m = parseMigration("0007_add_things.sql", "CREATE TABLE things (id int);");
    assert.equal(m.version, "0007");
    assert.equal(m.name, "add_things");
    assert.equal(m.transactional, true);
  });

  it("rejects badly named files", () => {
    for (const name of ["1_a.sql", "0001-a.sql", "0001_A.sql", "0001_.sql", "0001_a.txt", "a_0001.sql"]) {
      assert.equal(codeOf(() => parseMigration(name, "SELECT 1;")), "INVALID_FILENAME", name);
    }
  });

  it("rejects empty files", () => {
    assert.equal(codeOf(() => parseMigration("0001_a.sql", "  \n\n")), "INVALID_CONTENT");
  });

  it("rejects transaction control statements, which would break the runner's own transaction", () => {
    for (const sql of ["BEGIN;\nSELECT 1;", "select 1;\ncommit;", "  ROLLBACK ;", "START TRANSACTION;"]) {
      assert.equal(codeOf(() => parseMigration("0001_a.sql", sql)), "INVALID_CONTENT", sql);
    }
  });

  it("ignores BEGIN/END inside function bodies and comments", () => {
    const sql = "-- BEGIN; is fine in a comment\nCREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN 1;\nEND\n$$;";
    assert.equal(codeOf(() => parseMigration("0001_a.sql", sql)), undefined);
  });

  it("recognises the no-transaction marker and accepts exactly one statement", () => {
    const ok = parseMigration("0002_idx.sql", "-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);\n");
    assert.equal(ok.transactional, false);
  });

  it("no-transaction: rejects multiple statements, whatever else the file contains", () => {
    const marker = "-- migrate:no-transaction\n";
    const two = "CREATE INDEX CONCURRENTLY i ON t (c);\nCREATE INDEX CONCURRENTLY j ON t (d);\n";
    assert.equal(codeOf(() => parseMigration("0002_idx.sql", marker + two)), "INVALID_CONTENT");
    // A dollar sign anywhere must not switch the check off (regression: it used to).
    assert.equal(codeOf(() => parseMigration("0002_idx.sql", marker + two + "-- costs $5\n")), "INVALID_CONTENT");
    assert.equal(codeOf(() => parseMigration("0002_idx.sql", marker + "SELECT '$'; SELECT 2;")), "INVALID_CONTENT");
    assert.equal(codeOf(() => parseMigration("0002_idx.sql", marker + "SELECT $$a$$; SELECT 2;")), "INVALID_CONTENT");
  });

  it("no-transaction: accepts one statement even when it contains semicolons in quotes, comments or dollar bodies", () => {
    const marker = "-- migrate:no-transaction\n";
    const singles = [
      "ALTER TYPE mood ADD VALUE 'a;b';",
      "CREATE INDEX CONCURRENTLY i ON t (c); -- trailing; comment",
      "DO $$ BEGIN PERFORM 1; PERFORM 2; END $$;",
      "CREATE INDEX CONCURRENTLY \"i;x\" ON t (c)",
    ];
    for (const sql of singles) {
      assert.equal(codeOf(() => parseMigration("0002_x.sql", marker + sql)), undefined, sql);
    }
  });

  it("the no-transaction marker only counts in the file header", () => {
    const sql = "CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$\n-- migrate:no-transaction\nSELECT 1\n$$;\nSELECT 2;";
    assert.equal(parseMigration("0003_f.sql", sql).transactional, true);
  });

  it("rejects transaction control hidden after other statements, but not inside strings or bodies", () => {
    assert.equal(codeOf(() => parseMigration("0001_a.sql", "SELECT 1;\n  COMMIT;")), "INVALID_CONTENT");
    assert.equal(codeOf(() => parseMigration("0001_a.sql", "SELECT 1; END")), "INVALID_CONTENT");
    assert.equal(codeOf(() => parseMigration("0001_a.sql", "INSERT INTO t VALUES ('\nBEGIN;\n');")), undefined);
    assert.equal(codeOf(() => parseMigration("0001_a.sql", "DO $$ BEGIN COMMIT; END $$;")), undefined);
  });

  it("rejects BEGIN ATOMIC function bodies (their top-level semicolons cannot be split safely)", () => {
    const sql = "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT 1; END;";
    assert.equal(codeOf(() => parseMigration("0001_a.sql", sql)), "INVALID_CONTENT");
  });

  it("rejects a file with unterminated quoting", () => {
    assert.equal(codeOf(() => parseMigration("0001_a.sql", "SELECT 'oops;")), "INVALID_CONTENT");
  });
});

describe("checksums", () => {
  it("are identical for LF, CRLF and BOM versions of the same file (Git on Windows)", () => {
    const lf = "CREATE TABLE a (\n  id int\n);\n";
    assert.equal(checksumOf(lf), checksumOf(lf.replace(/\n/g, "\r\n")));
    assert.equal(checksumOf(lf), checksumOf("\uFEFF" + lf));
  });

  it("change when the content changes", () => {
    assert.notEqual(checksumOf("SELECT 1;"), checksumOf("SELECT 2;"));
  });
});

describe("loading a directory", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "mig-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns files sorted by version and ignores non-sql files", () => {
    writeFileSync(path.join(dir, "0002_b.sql"), "SELECT 2;");
    writeFileSync(path.join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(path.join(dir, "README.md"), "notes");
    assert.deepEqual(Array.from(loadMigrationFiles(dir), (f) => f.filename), ["0001_a.sql", "0002_b.sql"]);
  });

  it("rejects two files with the same version", () => {
    writeFileSync(path.join(dir, "0001_a.sql"), "SELECT 1;");
    writeFileSync(path.join(dir, "0001_b.sql"), "SELECT 2;");
    assert.equal(codeOf(() => loadMigrationFiles(dir)), "DUPLICATE_VERSION");
  });

  it("loads the real repository migrations", () => {
    const real = loadMigrationFiles(path.resolve(__dirname, "../../../migrations"));
    assert.ok(real.length >= 2);
    assert.deepEqual(Array.from(real, (f) => f.version), Array.from(real, (f) => f.version).sort());
  });
});
