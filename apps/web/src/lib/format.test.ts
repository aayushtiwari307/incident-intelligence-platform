import assert from "node:assert/strict";
import type { IncidentEventDto } from "@platform/shared";
import { describeEvent, errorText, relativeTime } from "./format";

const ev = (type: IncidentEventDto["type"], payload: Record<string, unknown>): IncidentEventDto => ({
  id: 1,
  type,
  actor: { id: null, label: "A" },
  payload,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("relativeTime", () => {
  const now = new Date("2026-01-10T12:00:00Z");
  it("formats recent and older times", () => {
    assert.equal(relativeTime("2026-01-10T11:59:40Z", now), "just now");
    assert.equal(relativeTime("2026-01-10T11:55:00Z", now), "5 minutes ago");
    assert.equal(relativeTime("2026-01-10T11:00:00Z", now), "1 hour ago");
    assert.equal(relativeTime("2026-01-08T12:00:00Z", now), "2 days ago");
    assert.equal(relativeTime("2025-12-01T12:00:00Z", now), "2025-12-01");
  });
  it("tolerates garbage and slight clock skew", () => {
    assert.equal(relativeTime("nope", now), "unknown");
    assert.equal(relativeTime("2026-01-10T12:00:30Z", now), "just now");
    assert.equal(relativeTime("2026-01-17T12:00:00Z", now), "in 7 days");
  });
});

describe("describeEvent", () => {
  it("describes each event type in plain text", () => {
    assert.equal(describeEvent(ev("created", { severity: "sev1" })), "opened the incident as SEV1");
    assert.equal(describeEvent(ev("status_changed", { from: "triggered", to: "acknowledged" })), "changed status from triggered to acknowledged");
    assert.equal(describeEvent(ev("assigned", { from: null, to: { id: "u", displayName: "Ada" } })), "assigned the incident to Ada");
    assert.equal(describeEvent(ev("assigned", { from: { id: "u", displayName: "Ada" }, to: null })), "removed the assignee");
    assert.equal(
      describeEvent(ev("assigned", { from: { id: "u", displayName: "Ada" }, to: null, reason: "member_removed" })),
      "unassigned Ada because they were removed from the organization",
    );
    assert.equal(describeEvent(ev("severity_changed", { from: "sev3", to: "sev1" })), "changed severity from SEV3 to SEV1");
    assert.equal(describeEvent(ev("edited", { field: "description" })), "edited the description");
    assert.equal(describeEvent(ev("comment", { body: "x" })), "commented");
    assert.equal(describeEvent(ev("resolution_changed", { operation: "created", version: 1 })), "added resolution details (version 1)");
    assert.equal(describeEvent(ev("resolution_changed", { operation: "updated", version: 2 })), "updated resolution details (version 2)");
  });
  it("does not interpret markup: the text is returned verbatim for React to escape", () => {
    assert.equal(describeEvent(ev("edited", { field: "title", to: "<img src=x onerror=alert(1)>" })), "renamed the incident to “<img src=x onerror=alert(1)>”");
  });
});

describe("errorText", () => {
  it("uses an error's message, otherwise a generic fallback", () => {
    assert.equal(errorText(new Error("boom")), "boom");
    assert.equal(errorText(undefined), "Something went wrong. Please try again.");
  });
});
