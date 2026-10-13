import { randomBytes } from "node:crypto";
import { Client } from "pg";
import type { PoolLike } from "../common/sql";
import { createPool } from "../db/pg-pool";
import { pgConnectSession } from "../db/migrate/pg-adapter";
import type { ConnectSession } from "../db/migrate/types";

export interface TestDatabase {
  /** Connection string to this unique scratch database, useful for a second real pool in Nest E2E tests. */
  connectionString: string;
  /** Opens a new dedicated session (own connection) on this database. */
  connect: ConnectSession;
  /** A pool on this database, for the services under test. Closed by drop(). */
  pool: PoolLike;
  /** Runs one statement on a short-lived connection and returns its rows. */
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  drop(): Promise<void>;
}

/** Creates an empty, uniquely named database on the server in TEST_DATABASE_URL. Never touches existing data. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) throw new Error("TEST_DATABASE_URL is required for integration tests");
  const name = `it_${randomBytes(6).toString("hex")}`;

  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const connect = pgConnectSession(url.toString());
  const pool = createPool({ connectionString: url.toString(), max: 10, connectTimeoutMs: 5000, statementTimeoutMs: 15000 });

  return {
    connectionString: url.toString(),
    connect,
    pool,
    async query<T>(sql: string, params?: readonly unknown[]) {
      const session = await connect();
      try {
        return (await session.query<T>(sql, params)).rows;
      } finally {
        await session.close();
      }
    },
    async drop() {
      await pool.end();
      const dropper = new Client({ connectionString: adminUrl });
      await dropper.connect();
      try {
        await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await dropper.end();
      }
    },
  };
}
