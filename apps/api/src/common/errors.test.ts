import assert from "node:assert/strict";
import { z } from "zod";
import { AppError, notFound, pgCode, rateLimited, validationFailed } from "./errors";

describe("AppError", () => {
  it("maps codes to HTTP statuses", () => {
    assert.equal(new AppError("UNAUTHENTICATED", "x").status, 401);
    assert.equal(new AppError("FORBIDDEN", "x").status, 403);
    assert.equal(notFound("Incident").status, 404);
    assert.equal(new AppError("VERSION_CONFLICT", "x").status, 409);
    assert.equal(new AppError("INVALID_TRANSITION", "x").status, 409);
  });

  it("validation errors list paths and messages but never the submitted values", () => {
    const parsed = z.object({ password: z.string().min(12) }).safeParse({ password: "hunter2" });
    assert.ok(!parsed.success);
    const err = validationFailed(parsed.error);
    assert.equal(err.status, 400);
    assert.ok(!JSON.stringify(err.details).includes("hunter2"));
    assert.deepEqual(Object.keys((err.details as Array<object>)[0] as object).sort(), ["message", "path"]);
  });

  it("rate-limit errors carry a Retry-After header of at least one second", () => {
    assert.equal(rateLimited(0.2).headers?.["Retry-After"], "1");
    assert.equal(rateLimited(61).headers?.["Retry-After"], "61");
  });

  it("pgCode reads SQLSTATE from driver errors and ignores everything else", () => {
    assert.equal(pgCode({ code: "23505" }), "23505");
    assert.equal(pgCode(new Error("x")), undefined);
    assert.equal(pgCode(null), undefined);
  });
});
