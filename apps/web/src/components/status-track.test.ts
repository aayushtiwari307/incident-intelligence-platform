import assert from "node:assert/strict";
import type { IncidentEventDto } from "@platform/shared";
import { trackSteps } from "./status-track";
import { incidentRef, initials } from "../lib/format";

const base = { createdAt: "2026-10-01T10:00:00.000Z", acknowledgedAt: null, mitigatedAt: null, resolvedAt: null, updatedAt: "2026-10-01T10:30:00.000Z" };
const changed = (to: string, createdAt: string, id: number): IncidentEventDto => ({ id, type: "status_changed", actor: { id: null, label: "x" }, payload: { from: "x", to }, createdAt });

describe("progress track", () => {
  it("marks earlier steps done, the current step current and later steps future", () => {
    const steps = trackSteps({ ...base, status: "investigating" }, [changed("acknowledged", "2026-10-01T10:05:00.000Z", 1), changed("investigating", "2026-10-01T10:30:00.000Z", 2)]);
    assert.deepEqual(steps.map((s) => s.state), ["done", "done", "current", "future", "future"]);
    assert.equal(steps[1]?.at, "2026-10-01T10:05:00.000Z");
    assert.equal(steps[3]?.at, null);
  });

  it("shows a stage that never happened as skipped instead of inventing it", () => {
    const steps = trackSteps({ ...base, status: "resolved", resolvedAt: "2026-10-01T11:00:00.000Z" }, [changed("resolved", "2026-10-01T11:00:00.000Z", 1)]);
    assert.deepEqual(steps.map((s) => s.state), ["done", "skipped", "skipped", "skipped", "current"]);
  });

  it("falls back to the incident's own timestamps when the timeline has no event for a step", () => {
    const steps = trackSteps({ ...base, status: "mitigated", acknowledgedAt: "2026-10-01T10:02:00.000Z", mitigatedAt: "2026-10-01T10:40:00.000Z" }, []);
    assert.equal(steps[1]?.state, "done");
    assert.equal(steps[1]?.at, "2026-10-01T10:02:00.000Z");
    assert.equal(steps[3]?.state, "current");
  });

  it("uses the latest time when a status was entered more than once (reopened incident)", () => {
    const steps = trackSteps({ ...base, status: "triggered" }, [changed("acknowledged", "2026-10-01T10:05:00.000Z", 1), changed("acknowledged", "2026-10-02T09:00:00.000Z", 2)]);
    assert.equal(steps[0]?.state, "current");
    assert.equal(steps[1]?.state, "future");
  });
});

describe("display helpers", () => {
  it("formats incident references and initials", () => {
    assert.equal(incidentRef(7), "INC-0007");
    assert.equal(incidentRef(12345), "INC-12345");
    assert.equal(initials("Aayush Tiwari"), "AT");
    assert.equal(initials("  madonna "), "M");
    assert.equal(initials(null), "?");
  });
});
