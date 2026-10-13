import path from "node:path";
import { redactSecrets } from "../../config/redact";
import { pgConnectSession } from "./pg-adapter";
import { runMigrations } from "./runner";
import { MigrationError } from "./types";

/** `node dist/db/migrate/cli.js apply|check`. Needs only DATABASE_URL, not the full API configuration. */
async function main(): Promise<number> {
  const mode = process.argv[2];
  if (mode !== "apply" && mode !== "check") {
    console.error("usage: migrate <apply|check>");
    return 2;
  }
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  const directory = path.resolve(__dirname, "../../../migrations");
  try {
    const result = await runMigrations(pgConnectSession(url), { mode, directory, log: (m) => console.log(m) });
    console.log(
      mode === "apply"
        ? `done: ${result.applied.length} applied, ${result.alreadyApplied} already applied`
        : `ok: ${result.alreadyApplied} migrations applied, none pending`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof MigrationError ? error.code : "ERROR";
    console.error(`migration ${code}: ${redactSecrets((error as Error).message)}`);
    return 1;
  }
}

void main().then((code) => process.exit(code));
