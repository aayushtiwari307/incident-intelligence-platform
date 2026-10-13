import "reflect-metadata";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { AppModule } from "./app.module";
import { configureHttpApplication } from "./http/configure-http";
import { createLogger } from "./common/logger";
import { createShutdownHandler } from "./common/shutdown";
import { ConfigError, describeConfig, loadConfig } from "./config/env";
import { redactSecrets } from "./config/redact";
import { pgConnectSession, runMigrations } from "./db/migrate";

async function bootstrap(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // Fail fast with every problem listed; the message never contains values.
    console.error(error instanceof ConfigError ? error.message : String(error));
    process.exit(1);
  }
  const log = createLogger(config.logLevel);
  log.info("configuration loaded", { config: describeConfig(config) });

  if (config.migrations.mode !== "off") {
    try {
      const result = await runMigrations(pgConnectSession(config.database.url.reveal(), config.database.connectTimeoutMs), {
        mode: config.migrations.mode,
        directory: path.resolve(__dirname, "../migrations"),
        log: (m) => log.info(m),
      });
      log.info("migrations ok", { applied: result.applied, alreadyApplied: result.alreadyApplied });
    } catch (error) {
      // Refuse to serve traffic against a schema the code does not match.
      log.error("migrations failed; not starting", { error: redactSecrets((error as Error).message) });
      process.exit(1);
    }
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    bodyParser: false,
    bufferLogs: false,
  });
  configureHttpApplication(app, config);
  // Signals are handled here, not through app.enableShutdownHooks(), so there is exactly one shutdown
  // path with one force-exit timer. app.close() still runs Nest's lifecycle hooks (the DB pool closes there).
  const shutdown = createShutdownHandler({ close: () => app.close(), log: (m, f) => log.info(m, f) });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => void shutdown(signal));
  }

  await app.listen(config.http.port, config.http.host);
  log.info("listening", { host: config.http.host, port: config.http.port });
}

void bootstrap();
