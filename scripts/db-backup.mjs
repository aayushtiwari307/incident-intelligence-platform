#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pgToolEnvironment } from "./db-host-guard.mjs";

export function backupArguments(outputFile) {
  return ["--format=custom", "--no-owner", "--no-acl", `--file=${outputFile}`];
}

export async function runBackup({ connectionString = process.env.DATABASE_URL, outputFile = process.env.IIP_DB_BACKUP_FILE } = {}) {
  if (!connectionString) throw new Error("Set DATABASE_URL to a disposable loopback PostgreSQL database");
  if (!outputFile) throw new Error("Set IIP_DB_BACKUP_FILE to the path for the new backup file");
  const resolved = path.resolve(outputFile);
  if (existsSync(resolved)) throw new Error("Refusing to overwrite an existing backup file");
  const allowNonLocal = process.env.IIP_ALLOW_NONLOCAL_DB === "1";
  const env = pgToolEnvironment(connectionString, { allowNonLocal });
  mkdirSync(path.dirname(resolved), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn("pg_dump", backupArguments(resolved), { env, stdio: "inherit", windowsHide: true });
    child.once("error", (error) => {
      try { rmSync(resolved, { force: true }); } catch { /* only remove the partial output created by this run */ }
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        try { rmSync(resolved, { force: true }); } catch { /* only remove the partial output created by this run */ }
        reject(new Error(`pg_dump failed (${signal ? `signal ${signal}` : `exit code ${code}`})`));
      }
    });
  });
  console.log(`Backup created: ${resolved}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBackup().catch((error) => {
    console.error(`db-backup: ${error instanceof Error ? error.message : "operation failed"}`);
    process.exitCode = 1;
  });
}
