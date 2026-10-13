/**
 * The smallest database surface the services need. `pg`'s Pool and PoolClient satisfy it structurally,
 * and tests can supply any other implementation backed by a real PostgreSQL session.
 */
export interface SqlClient {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }>;
}

export interface PooledClient extends SqlClient {
  /** Pass an error to discard the connection instead of returning it to the pool. */
  release(error?: unknown): void;
}

export interface PoolLike extends SqlClient {
  connect(): Promise<PooledClient>;
  end(): Promise<void>;
}

/** Runs a function on a pooled connection inside one transaction (BEGIN ... COMMIT, ROLLBACK on any error). */
export class Database implements SqlClient {
  constructor(private readonly pool: PoolLike) {}

  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    return this.pool.query<T>(text, params);
  }

  async tx<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let failure: unknown;
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      failure = error;
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // The connection is broken; make sure it is discarded rather than reused.
        failure = failure ?? rollbackError;
      }
      throw error;
    } finally {
      client.release(failure);
    }
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}
