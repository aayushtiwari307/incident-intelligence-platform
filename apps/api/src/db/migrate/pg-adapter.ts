import { Client } from "pg";
import type { ConnectSession } from "./types";

/**
 * One dedicated connection (not a pool): advisory locks belong to a session, and a pool could hand
 * the unlock to a different connection than the lock.
 */
export function pgConnectSession(databaseUrl: string, connectTimeoutMs = 5_000): ConnectSession {
  return async () => {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: connectTimeoutMs });
    await client.connect();
    return {
      query: async <T>(sql: string, params?: readonly unknown[]) => {
        const result = await client.query(sql, params ? [...params] : undefined);
        return { rows: result.rows as T[] };
      },
      close: () => client.end(),
    };
  };
}
