import { ArgumentsHost, Catch, type ExceptionFilter } from "@nestjs/common";
import type { Response } from "express";
import { createLogger } from "../common/logger";
import { redactSecrets } from "../config/redact";
import { isServerFault, toErrorResponse } from "./error-response";

const log = createLogger("info");

/** One place that turns every failure into the documented JSON error shape. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const response = toErrorResponse(error);
    if (isServerFault(error)) {
      // Details go to the log (secrets redacted), never to the client; the request id lets support correlate them.
      log.error("unhandled error", {
        error: redactSecrets(error instanceof Error ? (error.stack ?? error.message) : String(error)),
      });
    }
    if (res.headersSent) return;
    res.status(response.status);
    for (const [name, value] of Object.entries(response.headers ?? {})) res.setHeader(name, value);
    res.setHeader("Cache-Control", "no-store");
    res.json(response.body);
  }
}
