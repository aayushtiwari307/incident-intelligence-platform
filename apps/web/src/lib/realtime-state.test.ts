import assert from "node:assert/strict";
import type { IncidentDto, IncidentEventDto } from "@platform/shared";
import { acceptSnapshot, matchesFilters, mergeTimeline, reconcileList } from "./realtime-state";

const incident = (n: number, over: Partial<IncidentDto> = {}): IncidentDto => ({
  id: `id-${n}`,
  number: n,
  title: `Incident ${n}`,
  description: "",
  severity: "sev3",
  status: "triggered",
  assignee: null,
  createdBy: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  acknowledgedAt: null,
  mitigatedAt: null,
  resolvedAt: null,
  ...over,
});

const entry = (id: number): IncidentEventDto => ({ id, type: "comment", actor: { id: null, label: "a" }, payload: {}, createdAt: "2026-01-01T00:00:00.000Z" });

describe("acceptSnapshot", () => {
  it("takes the first snapshot it sees", () => {
    assert.equal(acceptSnapshot(null, incident(1)).version, 1);
  });
  it("never goes back to an older version", () => {
    const current = incident(1, { version: 5, title: "new" });
    assert.equal(acceptSnapshot(current, incident(1, { version: 4, title: "old" })), current);
  });
  it("takes a newer or equal version", () => {
    assert.equal(acceptSnapshot(incident(1, { version: 2 }), incident(1, { version: 3, title: "newer" })).title, "newer");
    assert.equal(acceptSnapshot(incident(1, { version: 2 }), incident(1, { version: 2, title: "same" })).title, "same");
  });
  it("switches to another incident outright (the page navigated)", () => {
    assert.equal(acceptSnapshot(incident(1, { version: 9 }), incident(2, { version: 1 })).id, "id-2");
  });
});

describe("mergeTimeline", () => {
  it("unions by id, oldest first, without duplicates", () => {
    const merged = mergeTimeline([entry(3), entry(1)], [entry(2), entry(3)]);
    assert.deepEqual(merged.map((e) => e.id), [1, 2, 3]);
  });
  it("keeps entries a shorter refetch did not include", () => {
    assert.deepEqual(mergeTimeline([entry(1), entry(2), entry(3)], [entry(1)]).map((e) => e.id), [1, 2, 3]);
  });
});

describe("matchesFilters", () => {
  const mine = incident(1, { assignee: { id: "me", displayName: "Me" } });
  it("applies status, severity and assignee filters like the server", () => {
    assert.equal(matchesFilters(mine, {}, "me"), true);
    assert.equal(matchesFilters(mine, { status: "resolved" }, "me"), false);
    assert.equal(matchesFilters(mine, { severity: "sev1" }, "me"), false);
    assert.equal(matchesFilters(mine, { assignee: "me" }, "me"), true);
    assert.equal(matchesFilters(mine, { assignee: "me" }, "someone-else"), false);
    assert.equal(matchesFilters(mine, { assignee: "unassigned" }, "me"), false);
    assert.equal(matchesFilters(incident(2), { assignee: "unassigned" }, "me"), true);
  });
});

describe("reconcileList", () => {
  const list = [incident(5), incident(4), incident(3)];

  it("replaces a listed incident with a newer snapshot", () => {
    const next = reconcileList(list, false, incident(4, { version: 2, title: "changed" }), true);
    assert.equal(next[1]?.title, "changed");
    assert.equal(next.length, 3);
  });
  it("ignores an older snapshot of a listed incident", () => {
    const current = [incident(4, { version: 3 })];
    assert.equal(reconcileList(current, false, incident(4, { version: 2 }), true), current);
  });
  it("removes a listed incident that no longer matches the filters", () => {
    assert.deepEqual(reconcileList(list, false, incident(4, { version: 2 }), false).map((i) => i.number), [5, 3]);
  });
  it("inserts a new matching incident in number order", () => {
    assert.deepEqual(reconcileList(list, false, incident(6), true).map((i) => i.number), [6, 5, 4, 3]);
    assert.deepEqual(reconcileList([incident(6), incident(4)], false, incident(5), true).map((i) => i.number), [6, 5, 4]);
  });
  it("does not insert a non-matching new incident", () => {
    assert.equal(reconcileList(list, false, incident(6), false), list);
  });
  it("when more pages exist, inserts only inside the loaded range", () => {
    assert.deepEqual(reconcileList(list, true, incident(6), true).map((i) => i.number), [6, 5, 4, 3]);
    assert.equal(reconcileList(list, true, incident(2), true), list, "belongs to a page that has not been loaded");
  });
  it("appends an older incident when everything is loaded", () => {
    assert.deepEqual(reconcileList(list, false, incident(2), true).map((i) => i.number), [5, 4, 3, 2]);
  });
  it("handles an empty list", () => {
    assert.deepEqual(reconcileList([], false, incident(1), true).map((i) => i.number), [1]);
  });
  it("does not mutate its input", () => {
    const copy = [...list];
    reconcileList(list, false, incident(6), true);
    assert.deepEqual(list, copy);
  });
});
