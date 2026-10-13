import assert from "node:assert/strict";
import {
  INCIDENT_STATUSES,
  INCIDENT_TRANSITIONS,
  canTransition,
  commentSchema,
  createIncidentSchema,
  incidentListQuerySchema,
  transitionIncidentSchema,
  updateIncidentSchema,
} from "./incident";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("incident lifecycle", () => {
  it("every status is a key, and every target is a known status", () => {
    assert.deepEqual(Object.keys(INCIDENT_TRANSITIONS).sort(), [...INCIDENT_STATUSES].sort());
    for (const targets of Object.values(INCIDENT_TRANSITIONS)) {
      for (const t of targets) assert.ok(INCIDENT_STATUSES.includes(t));
    }
  });

  it("no status transitions to itself", () => {
    for (const s of INCIDENT_STATUSES) assert.equal(canTransition(s, s), false);
  });

  it("allows the normal path and a reopen, refuses skipping back to triggered", () => {
    assert.equal(canTransition("triggered", "acknowledged"), true);
    assert.equal(canTransition("acknowledged", "investigating"), true);
    assert.equal(canTransition("investigating", "mitigated"), true);
    assert.equal(canTransition("mitigated", "resolved"), true);
    assert.equal(canTransition("resolved", "investigating"), true);
    assert.equal(canTransition("resolved", "triggered"), false);
    assert.equal(canTransition("resolved", "mitigated"), false);
    assert.equal(canTransition("investigating", "triggered"), false);
    assert.equal(canTransition("triggered", "mitigated"), false);
  });

  it("a resolved incident can only be reopened, so resolution is never silently undone", () => {
    assert.deepEqual(INCIDENT_TRANSITIONS.resolved, ["investigating"]);
  });
});

describe("incident request schemas", () => {
  it("create: trims the title, defaults the description, rejects unknown fields (including an organization id)", () => {
    const ok = createIncidentSchema.parse({ title: "  DB down  ", severity: "sev1" });
    assert.equal(ok.title, "DB down");
    assert.equal(ok.description, "");
    assert.equal(createIncidentSchema.safeParse({ title: "x", severity: "sev1", organizationId: UUID }).success, false);
  });

  it("create: rejects blank titles, bad severities and over-long input", () => {
    assert.equal(createIncidentSchema.safeParse({ title: "   ", severity: "sev1" }).success, false);
    assert.equal(createIncidentSchema.safeParse({ title: "x", severity: "sev9" }).success, false);
    assert.equal(createIncidentSchema.safeParse({ title: "x".repeat(201), severity: "sev1" }).success, false);
    assert.equal(createIncidentSchema.safeParse({ title: "x", severity: "sev1", description: "d".repeat(10_001) }).success, false);
  });

  it("update: needs expectedVersion and at least one real change; assignee may be explicitly cleared with null", () => {
    assert.equal(updateIncidentSchema.safeParse({ title: "x" }).success, false);
    assert.equal(updateIncidentSchema.safeParse({ expectedVersion: 1 }).success, false);
    assert.equal(updateIncidentSchema.safeParse({ expectedVersion: 0, title: "x" }).success, false);
    assert.equal(updateIncidentSchema.safeParse({ expectedVersion: 1, assigneeId: null }).success, true);
    assert.equal(updateIncidentSchema.safeParse({ expectedVersion: 1, assigneeId: "not-a-uuid" }).success, false);
  });

  it("transition: rejects unknown statuses and a missing version", () => {
    assert.equal(transitionIncidentSchema.safeParse({ to: "closed", expectedVersion: 1 }).success, false);
    assert.equal(transitionIncidentSchema.safeParse({ to: "resolved" }).success, false);
    assert.equal(transitionIncidentSchema.safeParse({ to: "resolved", expectedVersion: 3, note: "fixed" }).success, true);
  });

  it("comment: trims and rejects empty or huge bodies", () => {
    assert.equal(commentSchema.parse({ body: "  hi  " }).body, "hi");
    assert.equal(commentSchema.safeParse({ body: "   " }).success, false);
    assert.equal(commentSchema.safeParse({ body: "x".repeat(5001) }).success, false);
  });

  it("list query: coerces and bounds limit, accepts me/unassigned/uuid for assignee", () => {
    assert.equal(incidentListQuerySchema.parse({}).limit, 25);
    assert.equal(incidentListQuerySchema.parse({ limit: "50" }).limit, 50);
    assert.equal(incidentListQuerySchema.safeParse({ limit: "500" }).success, false);
    for (const assignee of ["me", "unassigned", UUID]) assert.equal(incidentListQuerySchema.safeParse({ assignee }).success, true);
    assert.equal(incidentListQuerySchema.safeParse({ assignee: "someone" }).success, false);
  });
});

import { analysisResultSchema } from "./incident";

describe("analysisResultSchema (the only accepted model output)", () => {
  const ok = { severity: "sev2", category: "Database", summary: "s", probableCause: "c", steps: ["a", "b"] };
  it("accepts a well-formed result", () => {
    assert.ok(analysisResultSchema.safeParse(ok).success);
  });
  it("rejects unknown keys, bad severities, empty or oversized fields and too many steps", () => {
    const bad = [
      { ...ok, extra: "x" },
      { ...ok, severity: "critical" },
      { ...ok, category: "" },
      { ...ok, summary: "x".repeat(2001) },
      { ...ok, steps: [] },
      { ...ok, steps: Array.from({ length: 9 }, () => "s") },
      { ...ok, steps: ["x".repeat(501)] },
      { ...ok, steps: "do it" },
    ];
    for (const b of bad) assert.equal(analysisResultSchema.safeParse(b).success, false, JSON.stringify(b).slice(0, 60));
  });
});
