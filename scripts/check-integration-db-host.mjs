#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isLoopbackHost } from "./db-host-guard.mjs";

/** Validate database host variables without emitting connection strings or credentials. */
export function checkIntegrationDatabaseHosts(env = process.env) {
  const checked = [];
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL"]) {
    const connectionString = env[key];
    if (!connectionString) {
      if (key === "TEST_DATABASE_URL") throw new Error("TEST_DATABASE_URL is required for integration tests (use a disposable local PostgreSQL server)");
      checked.push({ key, host: null, status: "unset" });
      continue;
    }
    let url;
    try { url = new URL(connectionString); } catch { throw new Error(`${key} is not a valid URL`); }
    if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new Error(`${key} must be a PostgreSQL URL`);
    if (!url.hostname || !isLoopbackHost(url.hostname)) throw new Error(`${key} must point to localhost, 127.0.0.0/8, or ::1; refusing all non-loopback hosts`);
    checked.push({ key, host: url.hostname.replace(/^\[|\]$/g, ""), status: "loopback" });
  }
  return checked;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    for (const result of checkIntegrationDatabaseHosts()) {
      console.log(`${result.key}: ${result.status}${result.host ? ` (${result.host})` : ""}`);
    }
  } catch (error) {
    console.error(`integration database guard: ${error instanceof Error ? error.message : "configuration rejected"}`);
    process.exitCode = 1;
  }
}
