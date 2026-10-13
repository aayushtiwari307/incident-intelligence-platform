import type { LogLevel } from "../config/env";
import { redactValue } from "../config/redact";
import { currentRequestId } from "./request-context";

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** One JSON object per line on stdout/stderr; values go through redaction before they are written. */
export function createLogger(minLevel: LogLevel) {
  const write = (level: LogLevel, message: string, fields?: Record<string, unknown>) => {
    if (order[level] < order[minLevel]) return;
    const line = JSON.stringify({
      time: new Date().toISOString(),
      level,
      message,
      requestId: currentRequestId(),
      ...(redactValue(fields ?? {}) as Record<string, unknown>),
    });
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(`${line}\n`);
  };
  return {
    debug: (m: string, f?: Record<string, unknown>) => write("debug", m, f),
    info: (m: string, f?: Record<string, unknown>) => write("info", m, f),
    warn: (m: string, f?: Record<string, unknown>) => write("warn", m, f),
    error: (m: string, f?: Record<string, unknown>) => write("error", m, f),
  };
}
export type Logger = ReturnType<typeof createLogger>;
