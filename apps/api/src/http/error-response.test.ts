import assert from "node:assert/strict";
import { AppError, notFound, rateLimited } from "../common/errors";
import { isServerFault, toErrorResponse } from "./error-response";

describe("toErrorResponse", () => {
  it("exposes AppError code, message, details and headers", () => {
    const r = toErrorResponse(rateLimited(30));
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, "RATE_LIMITED");
    assert.deepEqual(r.headers, { "Retry-After": "30" });
    assert.equal(toErrorResponse(notFound("Incident")).body.error.message, "Incident not found");
    const conflict = toErrorResponse(new AppError("VERSION_CONFLICT", "stale", { details: { currentVersion: 3 } }));
    assert.deepEqual(conflict.body.error.details, { currentVersion: 3 });
  });

  it("never leaks the message of an unexpected error", () => {
    const r = toErrorResponse(new Error("connect ECONNREFUSED postgres://user:hunter2@db/app"));
    assert.equal(r.status, 500);
    assert.ok(!JSON.stringify(r.body).includes("hunter2"));
    assert.equal(r.body.error.code, "INTERNAL");
  });

  it("maps framework errors by status without echoing them", () => {
    assert.equal(toErrorResponse({ status: 413, message: "secret detail" }).body.error.message, "Request body too large");
    assert.equal(toErrorResponse({ status: 404 }).status, 404);
    assert.equal(toErrorResponse({ status: 400 }).body.error.code, "VALIDATION_FAILED");
  });

  it("classifies server faults", () => {
    assert.equal(isServerFault(new Error("boom")), true);
    assert.equal(isServerFault(notFound()), false);
    assert.equal(isServerFault({ status: 404 }), false);
  });
});
