#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgToolEnvironment } from "./db-host-guard.mjs";

export function restoreArguments(inputFile, databaseName) {
  return ["--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", `--dbname=${databaseName}`, inputFile];
}

export async function runRestore({ connectionString = process.env.DATABASE_URL, inputFile = process.env.IIP_DB_RESTORE_FILE } = {}) {
  if (!connectionString) throw new Error("Set DATABASE_URL to a disposable loopback PostgreSQL database");
  if (!inputFile) throw new Error("Set IIP_DB_RESTORE_FILE to a custom-format backup file");
  if (process.env.IIP_RESTORE_CONFIRM !== "YES") throw new Error("Restore is destructive; set IIP_RESTORE_CONFIRM=YES after confirming the local target");
  const resolved = path.resolve(inputFile);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) throw new Error("IIP_DB_RESTORE_FILE must name an existing backup file");
  const allowNonLocal = process.env.IIP_ALLOW_NONLOCAL_DB === "1";
  const env = pgToolEnvironment(connectionString, { allowNonLocal });
  await new Promise((resolve, reject) => {
    const child = spawn("pg_restore", restoreArguments(resolved, env.PGDATABASE), { env, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`pg_restore failed (${signal ? `signal ${signal}` : `exit code ${code}`})`)));
  });
  console.log(`Restore completed to the explicitly selected target database: ${env.PGDATABASE}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runRestore().catch((error) => {
    console.error(`db-restore: ${error instanceof Error ? error.message : "operation failed"}`);
    process.exitCode = 1;
  });
}
