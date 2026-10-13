import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { splitStatements } from "./sql-statements";
import { MigrationError, type MigrationFile } from "./types";

const FILENAME = /^(\d{4})_([a-z0-9][a-z0-9_]*)\.sql$/;
const NO_TRANSACTION_MARKER = /^--\s*migrate:no-transaction\s*$/;
const CREATE_ROUTINE = /^create\s+(or\s+replace\s+)?(function|procedure)\b/i;
/** First word(s) of a statement that would start or end a transaction behind the runner's back. */
const TRANSACTION_CONTROL = /^(begin|commit|rollback|start\s+transaction|end|abort)\b(?!\s+atomic\b)/i;
const BEGIN_ATOMIC = /\bbegin\s+atomic\b/i;

/** The marker only counts in the header: blank and comment lines before the first statement. */
function declaresNoTransaction(sql: string): boolean {
  for (const line of sql.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (!trimmed.startsWith("--")) return false;
    if (NO_TRANSACTION_MARKER.test(trimmed)) return true;
  }
  return false;
}

/**
 * Checksums must not change when Git converts line endings on Windows, or when an editor adds a BOM,
 * so the content is normalised before hashing.
 */
export function normaliseSql(raw: string): string {
  return raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

export function checksumOf(raw: string): string {
  return createHash("sha256").update(normaliseSql(raw), "utf8").digest("hex");
}

export function parseMigration(filename: string, raw: string): MigrationFile {
  const match = FILENAME.exec(filename);
  if (!match) {
    throw new MigrationError(
      "INVALID_FILENAME",
      `Migration file "${filename}" must be named NNNN_lower_snake_name.sql (for example 0003_incidents.sql)`,
    );
  }
  const sql = normaliseSql(raw);
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    throw new MigrationError("INVALID_CONTENT", `Migration ${filename} contains no SQL statements`);
  }
  for (const statement of statements) {
    if (CREATE_ROUTINE.test(statement) && BEGIN_ATOMIC.test(statement)) {
      throw new MigrationError(
        "INVALID_CONTENT",
        `Migration ${filename} uses BEGIN ATOMIC, which is not supported; write the function body as a $$ ... $$ string`,
      );
    }
    if (TRANSACTION_CONTROL.test(statement)) {
      throw new MigrationError(
        "INVALID_CONTENT",
        `Migration ${filename} contains BEGIN/COMMIT/ROLLBACK. The runner owns the transaction; remove it, ` +
          `or use "-- migrate:no-transaction" for a statement that cannot run inside one.`,
      );
    }
  }
  const transactional = !declaresNoTransaction(sql);
  if (!transactional && statements.length !== 1) {
    // Without a transaction a multi-statement file could stop half way with no way back.
    throw new MigrationError(
      "INVALID_CONTENT",
      `Migration ${filename} is marked no-transaction, so it must contain exactly one statement (found ${statements.length})`,
    );
  }
  return {
    version: match[1] as string,
    name: match[2] as string,
    filename,
    sql,
    checksum: checksumOf(raw),
    transactional,
  };
}

/** Reads and validates every migration file in a directory, sorted by version. */
export function loadMigrationFiles(dir: string): MigrationFile[] {
  const filenames = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const files = filenames.map((filename) => parseMigration(filename, readFileSync(path.join(dir, filename), "utf8")));
  const seen = new Map<string, string>();
  for (const file of files) {
    const previous = seen.get(file.version);
    if (previous) {
      throw new MigrationError("DUPLICATE_VERSION", `Migrations ${previous} and ${file.filename} share version ${file.version}`);
    }
    seen.set(file.version, file.filename);
  }
  return files;
}
