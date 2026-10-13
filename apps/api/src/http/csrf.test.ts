import assert from "node:assert/strict";
import { isOriginAllowed } from "./csrf";

const allowed = ["http://localhost:3000", "http://127.0.0.1:3000"];
const check = (method: string, origin?: string) => isOriginAllowed({ method, origin, allowedOrigins: allowed });

describe("CSRF origin check", () => {
  it("allows safe methods from any origin (they cannot change state)", () => {
    for (const m of ["GET", "HEAD", "OPTIONS", "get"]) assert.equal(check(m, "https://evil.example"), true);
  });

  it("allows unsafe methods from allow-listed origins", () => {
    for (const m of ["POST", "PATCH", "PUT", "DELETE"]) assert.equal(check(m, "http://localhost:3000"), true);
  });

  it("rejects unsafe methods from any other origin, including look-alikes", () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost:3001",
      "http://localhost:3000.evil.example",
      "https://localhost:3000",
      "null",
      "",
    ]) {
      assert.equal(check("POST", origin), false, origin);
    }
  });

  it("allows unsafe methods with no Origin header (not a cross-origin browser request)", () => {
    assert.equal(check("POST", undefined), true);
  });
});
