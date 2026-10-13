import { Pool } from "pg";
import type { PoolLike } from "../common/sql";

export interface PoolSettings {
  connectionString: string;
  max: number;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
}

/**
 * Wraps a real `pg` Pool in the small PoolLike interface the services use. Written out explicitly (instead of
 * relying on structural typing of pg's overloads) so the boundary is obvious and type-safe.
 */
export function createPool(settings: PoolSettings): PoolLike {
  const pool = new Pool({
    connectionString: settings.connectionString,
    max: settings.max,
    connectionTimeoutMillis: settings.connectTimeoutMs,
    statement_timeout: settings.statementTimeoutMs,
  });
  // An idle client error must not crash the process; the pool discards the client.
  pool.on("error", () => undefined);

  return {
    async query<T>(text: string, params?: readonly unknown[]) {
      const result = await pool.query(text, params ? [...params] : undefined);
      return { rows: result.rows as T[] };
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query<T>(text: string, params?: readonly unknown[]) {
          const result = await client.query(text, params ? [...params] : undefined);
          return { rows: result.rows as T[] };
        },
        release(error?: unknown) {
          client.release(error === undefined || error === null ? undefined : true);
        },
      };
    },
    end: () => pool.end(),
  };
}
