import assert from "node:assert/strict";
import test from "node:test";
import { isLoopbackHost, parseDatabaseTarget, pgToolEnvironment } from "./db-host-guard.mjs";
import { backupArguments } from "./db-backup.mjs";
import { restoreArguments } from "./db-restore.mjs";

test("database host guard allows only explicit loopback forms by default", () => {
  for (const host of ["localhost", "127.0.0.1", "127.0.0.2", "127.255.255.255", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["neon.tech", "127.0.0.256", "192.168.1.10", "localhost.example.com"]) assert.equal(isLoopbackHost(host), false, host);
  assert.throws(() => parseDatabaseTarget("postgresql://user:secret@ep-example.neon.tech/db"), /Refusing a non-local/);
  assert.deepEqual(parseDatabaseTarget("postgresql://u:p@127.0.0.1:5434/testdb?sslmode=disable"), {
    host: "127.0.0.1", port: "5434", database: "testdb", user: "u", password: "p", sslmode: "disable",
  });
});

test("non-local targets require an explicit override and secrets stay in environment variables", () => {
  assert.equal(parseDatabaseTarget("postgresql://u:p@db.example.test/db", { allowNonLocal: true }).host, "db.example.test");
  const env = pgToolEnvironment("postgresql://u:super-secret@localhost/db", { base: { PATH: "safe" } });
  assert.equal(env.PGPASSWORD, "super-secret");
  assert.equal(env.PGHOST, "localhost");
  assert.equal(JSON.stringify(backupArguments("backup.dump")).includes("super-secret"), false);
  assert.deepEqual(restoreArguments("backup.dump", "db"), ["--clean", "--if-exists", "--no-owner", "--no-acl", "--exit-on-error", "--dbname=db", "backup.dump"]);
  assert.throws(() => parseDatabaseTarget("postgresql://u:p@localhost/db?sslmode=secret"), /unsupported sslmode/);
});

import { checkIntegrationDatabaseHosts } from "./check-integration-db-host.mjs";

test("integration test guard refuses all non-loopback database URL hosts and reports no secrets", () => {
  assert.deepEqual(checkIntegrationDatabaseHosts({ TEST_DATABASE_URL: "postgresql://u:p@localhost/testdb" }), [
    { key: "DATABASE_URL", host: null, status: "unset" },
    { key: "TEST_DATABASE_URL", host: "localhost", status: "loopback" },
  ]);
  assert.throws(() => checkIntegrationDatabaseHosts({ TEST_DATABASE_URL: "postgresql://u:p@ep-prod.neon.tech/testdb" }), /non-loopback/);
  assert.throws(() => checkIntegrationDatabaseHosts({ DATABASE_URL: "postgresql://u:p@ep-prod.neon.tech/main", TEST_DATABASE_URL: "postgresql://u:p@localhost/testdb" }), /DATABASE_URL.*non-loopback/);
  assert.throws(() => checkIntegrationDatabaseHosts({}), /TEST_DATABASE_URL is required/);
});
