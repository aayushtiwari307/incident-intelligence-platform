import assert from "node:assert/strict";
import { splitStatements } from "./sql-statements";
import { MigrationError } from "./types";

const count = (sql: string) => splitStatements(sql).length;

function failure(sql: string): string | undefined {
  try {
    splitStatements(sql);
  } catch (error) {
    return error instanceof MigrationError ? error.code : "other";
  }
  return undefined;
}

describe("splitStatements: where a semicolon does and does not end a statement", () => {
  it("splits plain statements and ignores empty ones", () => {
    assert.deepEqual(splitStatements("SELECT 1;; SELECT 2 ;\n;"), ["SELECT 1", "SELECT 2"]);
    assert.equal(count("SELECT 1"), 1, "a final statement needs no semicolon");
  });

  it("returns nothing for empty or comment-only input", () => {
    assert.equal(count(""), 0);
    assert.equal(count("  \n"), 0);
    assert.equal(count("-- only a comment;\n/* and ; another */"), 0);
  });

  it("does not split on semicolons inside line and block comments (including nested)", () => {
    assert.equal(count("SELECT 1; -- ; SELECT 2;\n"), 1);
    assert.equal(count("SELECT /* ; */ 1"), 1);
    assert.equal(count("SELECT /* outer /* inner ; */ still comment ; */ 1"), 1);
  });

  it("does not split on semicolons inside single-quoted strings", () => {
    assert.equal(count("INSERT INTO t VALUES ('a;b')"), 1);
    assert.equal(count("INSERT INTO t VALUES ('it''s; fine')"), 1);
  });

  it("treats backslash as an escape only in E'' strings", () => {
    assert.equal(count("SELECT E'a\\'; b'"), 1, "escaped quote keeps the string open");
    assert.equal(count("SELECT 'a\\'; SELECT 2"), 2, "in a normal string the backslash is literal, so the quote closes it");
  });

  it("does not split on semicolons inside quoted identifiers", () => {
    assert.equal(count('CREATE TABLE "a;b" (id int)'), 1);
    assert.equal(count('CREATE TABLE "a""; b" (id int)'), 1);
  });

  it("does not split inside dollar-quoted bodies, anonymous or tagged", () => {
    assert.equal(count("CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$"), 1);
    assert.equal(count("DO $body$ BEGIN PERFORM 1; PERFORM 2; END $body$;"), 1);
    assert.equal(count("SELECT $a$ one; $$ two; $a$"), 1, "a different tag does not close the body");
  });

  it("splits statements that follow a dollar-quoted body", () => {
    assert.equal(count("DO $$ BEGIN PERFORM 1; END $$; SELECT 2;"), 2);
  });

  it("does not mistake parameters or identifiers for dollar quotes", () => {
    assert.equal(count("SELECT $1; SELECT $2"), 2, "$1 is a parameter, not a quote");
    assert.equal(count("SELECT foo$bar; SELECT 2"), 2, "$ inside an identifier is not a quote");
  });

  it("a lone dollar sign anywhere else does not make the file look single-statement (the old heuristic's bug)", () => {
    // Old check: "contains $ => accept". Both of these are two statements.
    assert.equal(count("CREATE INDEX CONCURRENTLY a ON t (c); CREATE INDEX CONCURRENTLY b ON t (d); -- cost: $5"), 2);
    assert.equal(count("SELECT '$'; SELECT 2"), 2);
  });

  it("rejects unterminated constructs instead of guessing", () => {
    assert.equal(failure("SELECT 'open"), "INVALID_CONTENT");
    assert.equal(failure('SELECT "open'), "INVALID_CONTENT");
    assert.equal(failure("SELECT /* open"), "INVALID_CONTENT");
    assert.equal(failure("SELECT $$ open"), "INVALID_CONTENT");
    assert.equal(failure("SELECT $tag$ open $other$"), "INVALID_CONTENT");
  });

  it("replaces comments with whitespace so the first keyword is easy to read", () => {
    assert.deepEqual(splitStatements("-- header\n/* x */ CREATE TABLE t (id int);"), ["CREATE TABLE t (id int)"]);
  });
});
