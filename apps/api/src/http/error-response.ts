import { AppError } from "../common/errors";
import type { ErrorResponse } from "./http-types";

/** Maps any thrown value to a safe response. Only AppError messages reach the client; everything else is a generic 500. */
export function toErrorResponse(error: unknown): ErrorResponse {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: { error: { code: error.code, message: error.message, ...(error.details !== undefined ? { details: error.details } : {}) } },
      ...(error.headers ? { headers: error.headers } : {}),
    };
  }
  // Framework errors (unknown route, malformed JSON, oversized body) carry a public status; map them without leaking internals.
  const status = typeof error === "object" && error !== null && "status" in error ? Number((error as { status: unknown }).status) : NaN;
  if (status === 404) return { status, body: { error: { code: "NOT_FOUND", message: "Not found" } } };
  if (status === 413) return { status, body: { error: { code: "VALIDATION_FAILED", message: "Request body too large" } } };
  if (status === 400) return { status, body: { error: { code: "VALIDATION_FAILED", message: "The request is invalid" } } };
  if (status === 405) return { status, body: { error: { code: "NOT_FOUND", message: "Not found" } } };
  return { status: 500, body: { error: { code: "INTERNAL", message: "Something went wrong" } } };
}

/** True for errors that are bugs or outages (worth logging with a stack), false for expected client errors. */
export const isServerFault = (error: unknown): boolean => !(error instanceof AppError) && toErrorResponse(error).status >= 500;
