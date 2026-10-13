import type { ZodError } from "zod";

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "VERSION_CONFLICT"
  | "INVALID_TRANSITION"
  | "RATE_LIMITED"
  | "FEATURE_DISABLED"
  | "ORIGIN_NOT_ALLOWED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VERSION_CONFLICT: 409,
  INVALID_TRANSITION: 409,
  RATE_LIMITED: 429,
  FEATURE_DISABLED: 409,
  ORIGIN_NOT_ALLOWED: 403,
  INTERNAL: 500,
};

/**
 * An expected failure with a stable machine-readable code. Services throw these; the HTTP layer turns them
 * into responses. Anything that is NOT an AppError is a bug and becomes a generic 500 (details only in logs).
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly headers?: Record<string, string>;

  constructor(code: ErrorCode, message: string, options?: { details?: unknown; headers?: Record<string, string> }) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS[code];
    this.details = options?.details;
    this.headers = options?.headers;
  }
}

export const unauthenticated = (message = "Authentication required") => new AppError("UNAUTHENTICATED", message);
export const forbidden = (message = "You do not have permission to do this") => new AppError("FORBIDDEN", message);
/** Also used when a resource exists in ANOTHER organization: the caller must not be able to tell the difference. */
export const notFound = (what = "Resource") => new AppError("NOT_FOUND", `${what} not found`);
export const conflict = (message: string) => new AppError("CONFLICT", message);

export function validationFailed(error: ZodError): AppError {
  const details = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  return new AppError("VALIDATION_FAILED", "The request is invalid", { details });
}

export function rateLimited(retryAfterSeconds: number): AppError {
  return new AppError("RATE_LIMITED", "Too many attempts, try again later", {
    headers: { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

/** PostgreSQL error codes the services translate into domain errors. */
export const PG = {
  uniqueViolation: "23505",
  foreignKeyViolation: "23503",
  checkViolation: "23514",
  serializationFailure: "40001",
  deadlock: "40P01",
} as const;

export const pgCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
