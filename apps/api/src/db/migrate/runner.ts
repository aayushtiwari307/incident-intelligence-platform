import { loadMigrationFiles } from "./files";
import { MigrationError, type ConnectSession, type MigrationFile, type MigrationSession } from "./types";

export interface RunOptions {
  /** `apply` runs pending migrations; `check` only verifies that none are pending or inconsistent. */
  mode: "apply" | "check";
  directory: string;
  /** How long to wait for another runner to finish. Default 30 s. */
  lockTimeoutMs?: number;
  lockPollMs?: number;
  log?: (message: string) => void;
}

export interface RunResult {
  applied: string[];
  alreadyApplied: number;
}

/** Arbitrary but stable 64-bit key; the same string must be used by every instance of the app. */
const LOCK_NAME = "incident-platform:schema-migrations";

interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function acquireLock(session: MigrationSession, timeoutMs: number, pollMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await session.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked",
      [LOCK_NAME],
    );
    if (rows[0]?.locked === true) return;
    if (Date.now() >= deadline) {
      throw new MigrationError(
        "LOCK_TIMEOUT",
        `Another migration run held the lock for more than ${timeoutMs} ms. Refusing to start without it.`,
      );
    }
    await sleep(pollMs);
  }
}

async function readApplied(session: MigrationSession): Promise<AppliedRow[]> {
  const exists = await session.query<{ present: boolean }>("SELECT to_regclass('schema_migrations') IS NOT NULL AS present");
  if (exists.rows[0]?.present !== true) return [];
  const { rows } = await session.query<AppliedRow>("SELECT version, name, checksum FROM schema_migrations ORDER BY version");
  return rows;
}

/**
 * Compares history with files. Throws on any inconsistency, before anything is applied:
 *  - an applied migration whose file is gone, renamed, or edited
 *  - a new migration numbered lower than one already applied (history would be applied out of order)
 */
export function planMigrations(files: readonly MigrationFile[], applied: readonly AppliedRow[]): MigrationFile[] {
  const byVersion = new Map(files.map((f) => [f.version, f]));
  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      throw new MigrationError("MISSING_FILE", `Migration ${row.version}_${row.name} is recorded as applied but its file is missing`);
    }
    if (file.name !== row.name) {
      throw new MigrationError("NAME_MISMATCH", `Migration ${row.version} was applied as "${row.name}" but the file is now named "${file.name}"`);
    }
    if (file.checksum !== row.checksum) {
      throw new MigrationError(
        "CHECKSUM_MISMATCH",
        `Migration ${file.filename} was modified after it was applied. Never edit an applied migration; add a new one.`,
      );
    }
  }
  const appliedVersions = new Set(applied.map((r) => r.version));
  const highest = applied.reduce((max, r) => (r.version > max ? r.version : max), "");
  const pending = files.filter((f) => !appliedVersions.has(f.version));
  const outOfOrder = pending.find((f) => f.version < highest);
  if (outOfOrder) {
    throw new MigrationError(
      "OUT_OF_ORDER",
      `Migration ${outOfOrder.filename} is older than the latest applied migration (${highest}). Renumber it above ${highest}.`,
    );
  }
  return pending;
}

async function applyOne(session: MigrationSession, file: MigrationFile): Promise<void> {
  const started = Date.now();
  const record = () =>
    session.query("INSERT INTO schema_migrations (version, name, checksum, execution_ms) VALUES ($1, $2, $3, $4)", [
      file.version,
      file.name,
      file.checksum,
      Date.now() - started,
    ]);

  if (!file.transactional) {
    // Cannot be atomic with its own history row; the file is a single statement, and a crash between
    // the two leaves it applied-but-unrecorded, which the file must tolerate (e.g. IF NOT EXISTS).
    await session.query(file.sql);
    await record();
    return;
  }

  await session.query("BEGIN");
  try {
    await session.query(file.sql);
    await record();
    await session.query("COMMIT");
  } catch (error) {
    try {
      await session.query("ROLLBACK");
    } catch {
      // The connection is probably gone; the server rolls back an open transaction on disconnect.
    }
    throw error;
  }
}

export async function runMigrations(connect: ConnectSession, options: RunOptions): Promise<RunResult> {
  const log = options.log ?? (() => undefined);
  const files = loadMigrationFiles(options.directory);
  const session = await connect();
  let locked = false;
  try {
    if (options.mode === "apply") {
      await acquireLock(session, options.lockTimeoutMs ?? 30_000, options.lockPollMs ?? 100);
      locked = true;
      await session.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version      text        PRIMARY KEY,
           name         text        NOT NULL,
           checksum     text        NOT NULL,
           applied_at   timestamptz NOT NULL DEFAULT now(),
           execution_ms integer     NOT NULL
         )`,
      );
    }

    // Read history only after the lock is held, so a concurrent runner's work is visible.
    const applied = await readApplied(session);
    const pending = planMigrations(files, applied);

    if (options.mode === "check") {
      if (pending.length > 0) {
        throw new MigrationError(
          "PENDING_MIGRATIONS",
          `Database is behind: ${pending.length} pending migration(s): ${pending.map((f) => f.filename).join(", ")}`,
        );
      }
      return { applied: [], alreadyApplied: applied.length };
    }

    const done: string[] = [];
    for (const file of pending) {
      log(`applying ${file.filename}`);
      try {
        await applyOne(session, file);
      } catch (error) {
        if (error instanceof MigrationError) throw error;
        throw new MigrationError("MIGRATION_FAILED", `Migration ${file.filename} failed: ${(error as Error).message}`, {
          cause: error,
        });
      }
      done.push(file.filename);
    }
    return { applied: done, alreadyApplied: applied.length };
  } finally {
    if (locked) {
      try {
        await session.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [LOCK_NAME]);
      } catch {
        // Closing the session releases the lock anyway.
      }
    }
    await session.close();
  }
}
