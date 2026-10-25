import assert from "node:assert/strict";
import { describe, it } from "@jest/globals";
import { CHANGE_CORRELATION_LABEL, CHANGE_MAX_AGE_MS, parseChangeTimestamp, isWithinIncidentChangeWindow } from "./change-correlation";

const NOW = new Date("2026-10-25T04:00:00.000Z");

describe("parseChangeTimestamp", () => {
  it("normalizes valid RFC 3339 offsets to a UTC instant", () => {
    assert.equal(parseChangeTimestamp("2026-10-25T09:00:00+05:00", NOW)?.toISOString(), "2026-10-25T04:00:00.000Z");
    assert.equal(parseChangeTimestamp("2026-10-25t04:00:00z", NOW)?.toISOString(), "2026-10-25T04:00:00.000Z");
  });

  it("rejects impossible calendar dates rather than allowing Date.parse normalization", () => {
    for (const value of [
      "2026-09-31T12:00:00Z",
      "2026-02-29T12:00:00Z",
      "2024-02-30T12:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-01-01T24:00:00Z",
      "2026-01-01T00:60:00Z",
      "2026-01-01T00:00:60Z",
      "2026-01-01T00:00:00+25:00",
      "2026-01-01T00:00:00-00:00",
    ]) assert.equal(parseChangeTimestamp(value, NOW), null, value);
  });

  it("accepts leap day only in leap years", () => {
    const leapDayNow = new Date("2024-03-01T12:00:00.000Z");
    assert.equal(parseChangeTimestamp("2024-02-29T12:00:00Z", leapDayNow)?.toISOString(), "2024-02-29T12:00:00.000Z");
    assert.equal(parseChangeTimestamp("2025-02-29T12:00:00Z", NOW), null);
  });

  it("requires an explicit timezone and a bounded timestamp string", () => {
    assert.equal(parseChangeTimestamp("2026-10-25T04:00:00", NOW), null);
    assert.equal(parseChangeTimestamp("2026-10-25", NOW), null);
    assert.equal(parseChangeTimestamp("x".repeat(41), NOW), null);
  });

  it("enforces inclusive age and clock-skew bounds", () => {
    assert.ok(parseChangeTimestamp(new Date(NOW.getTime() - CHANGE_MAX_AGE_MS).toISOString(), NOW));
    assert.ok(parseChangeTimestamp(new Date(NOW.getTime() + 5 * 60_000).toISOString(), NOW));
    assert.equal(parseChangeTimestamp(new Date(NOW.getTime() - CHANGE_MAX_AGE_MS - 1).toISOString(), NOW), null);
    assert.equal(parseChangeTimestamp(new Date(NOW.getTime() + 5 * 60_000 + 1).toISOString(), NOW), null);
  });
});

describe("incident/change correlation window", () => {
  const started = new Date("2026-10-25T04:00:00.000Z");
  it("accepts both boundaries and rejects changes after or before the window", () => {
    assert.equal(isWithinIncidentChangeWindow(new Date(started.getTime() - 24 * 60 * 60_000), started), true);
    assert.equal(isWithinIncidentChangeWindow(started, started), true);
    assert.equal(isWithinIncidentChangeWindow(new Date(started.getTime() + 1), started), false);
    assert.equal(isWithinIncidentChangeWindow(new Date(started.getTime() - 24 * 60 * 60_000 - 1), started), false);
  });

  it("keeps the explanatory label explicitly non-causal", () => {
    assert.equal(CHANGE_CORRELATION_LABEL, "correlation, not proven cause");
  });
});
