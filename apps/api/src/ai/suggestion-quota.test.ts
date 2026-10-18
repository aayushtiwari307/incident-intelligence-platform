import assert from "node:assert/strict";
import { reserveDailyQuota, secondsUntilUtcMidnight } from "./suggestion-quota";

describe("quota helpers (pure parts; the atomic SQL is covered by the real-PostgreSQL suite)", () => {
  it("computes Retry-After as the seconds until the next UTC midnight", () => {
    assert.equal(secondsUntilUtcMidnight(new Date("2026-10-18T23:59:00.000Z")), 60);
    assert.equal(secondsUntilUtcMidnight(new Date("2026-10-18T00:00:00.000Z")), 86_400);
    assert.equal(secondsUntilUtcMidnight(new Date("2026-12-31T12:00:00.000Z")), 12 * 3600);
  });

  it("never reserves with a nonsensical limit (no database call is made)", async () => {
    const never = { query: () => Promise.reject(new Error("must not query")) };
    for (const limit of [0, -5, 1.5, Number.NaN]) assert.equal(await reserveDailyQuota(never, "org", limit), null);
  });
});
