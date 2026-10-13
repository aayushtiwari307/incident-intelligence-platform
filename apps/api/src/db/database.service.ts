import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/env";
import { Database } from "../common/sql";
import { createPool } from "./pg-pool";

/** Owns the connection pool. Services receive `database` (queries and transactions), never the pool itself. */
@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  readonly database: Database;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.database = new Database(
      createPool({
        connectionString: config.database.url.reveal(),
        max: config.database.poolMax,
        connectTimeoutMs: config.database.connectTimeoutMs,
        statementTimeoutMs: config.database.statementTimeoutMs,
      }),
    );
  }

  async ping(): Promise<void> {
    await this.database.query("SELECT 1");
  }

  async onApplicationShutdown(): Promise<void> {
    await this.database.close();
  }
}
