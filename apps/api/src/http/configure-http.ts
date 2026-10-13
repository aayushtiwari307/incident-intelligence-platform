import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { requestIdMiddleware } from "../common/request-context";
import type { AppConfig } from "../config/env";
import { ApiExceptionFilter } from "./exception.filter";

/** Shared production/test HTTP adapter configuration so E2E tests exercise the same middleware path as main.ts. */
export function configureHttpApplication(app: NestExpressApplication, config: AppConfig): void {
  app.useBodyParser("json", { limit: config.http.bodyLimitBytes });
  app.set("trust proxy", config.http.trustProxyHops);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.use(requestIdMiddleware);
  app.use(helmet());
  app.enableCors({ origin: config.http.corsOrigins, credentials: true });
}
