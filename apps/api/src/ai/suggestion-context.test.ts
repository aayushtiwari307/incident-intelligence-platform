import assert from "node:assert/strict";
import { CONTEXT_LIMITS, assembleSuggestionContext, type IncidentText } from "./suggestion-context";

const current = {
  incidentId: "11111111-1111-4111-8111-111111111111",
  title: "Checkout database pool saturated",
  description: "Pool exhausted. Contact ops@corp.io. password=hunter2-correct-horse",
  severity: "sev2" as const,
  status: "investigating",
  version: 3,
};

const similar = (n: number, extra: Partial<IncidentText> = {}): IncidentText => ({
  incidentId: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
  title: `Earlier pool incident ${n}`,
  description: "database pool saturation",
  rootCause: "Worker exhaustion",
  fixApplied: "Expanded the connection pool",
  ...extra,
});

describe("suggestion context assembly", () => {
  it("labels the current incident S0 and similar incidents S1.. in rank order", () => {
    const ctx = assembleSuggestionContext(current, [similar(1), similar(2)]);
    assert.deepEqual(
      ctx.sources.map((s) => [s.alias, s.role]),
      [["S0", "current"], ["S1", "similar"], ["S2", "similar"]],
    );
    assert.equal(ctx.sources[0]?.incidentId, current.incidentId);
    assert.ok(ctx.sources[1]?.text.includes("Fix applied: Expanded the connection pool"));
  });

  it("redacts before anything is sent and counts what it removed", () => {
    const ctx = assembleSuggestionContext(current, []);
    const text = ctx.sources[0]?.text ?? "";
    assert.ok(!text.includes("ops@corp.io") && !text.includes("hunter2"));
    assert.equal(ctx.redactions.email, 1);
    assert.equal(ctx.redactions.password_pair, 1);
  });

  it("redacts a secret that would straddle the field limit instead of leaking a fragment", () => {
    const secret = "sk-" + "A1b2C3d4E5".repeat(5);
    const description = "x".repeat(CONTEXT_LIMITS.description - 10) + ` ${secret}`;
    const ctx = assembleSuggestionContext({ ...current, description }, []);
    const text = ctx.sources[0]?.text ?? "";
    assert.ok(!text.includes("sk-"), "no fragment of the key survives truncation");
    assert.ok(!text.includes("A1b2C3d4E5"));
  });

  it("bounds the number of similar sources, each field, and the total size", () => {
    const many = Array.from({ length: 12 }, (_, i) => similar(i + 1));
    assert.equal(assembleSuggestionContext(current, many).sources.length, 1 + CONTEXT_LIMITS.maxSimilar);

    const long = assembleSuggestionContext({ ...current, description: "d".repeat(50_000) }, []);
    assert.equal(long.truncated, true);
    assert.ok((long.sources[0]?.text.length ?? 0) <= CONTEXT_LIMITS.title + CONTEXT_LIMITS.description + 100);

    const huge = Array.from({ length: 5 }, (_, i) =>
      similar(i + 1, { description: "e".repeat(CONTEXT_LIMITS.description), rootCause: "r".repeat(2000), fixApplied: "f".repeat(2000) }),
    );
    const bounded = assembleSuggestionContext({ ...current, description: "d".repeat(CONTEXT_LIMITS.description) }, huge);
    const total = bounded.sources.reduce((sum, s) => sum + s.text.length, 0);
    assert.ok(total <= CONTEXT_LIMITS.maxTotalChars, `total ${total}`);
    assert.equal(bounded.truncated, true);
    assert.equal(bounded.sources[0]?.alias, "S0", "the current incident is never dropped");
  });

  it("never lists the current incident or a duplicate among the similar ones", () => {
    const ctx = assembleSuggestionContext(current, [similar(1), similar(1), { ...similar(2), incidentId: current.incidentId }]);
    assert.deepEqual(
      ctx.sources.map((s) => s.alias),
      ["S0", "S1"],
    );
  });

  it("carries no identity: only aliases, text and the incident's own metadata", () => {
    const ctx = assembleSuggestionContext(current, [similar(1)]);
    const sent = JSON.stringify(ctx.sources.map((s) => ({ alias: s.alias, text: s.text })));
    assert.ok(!sent.includes(current.incidentId));
    assert.deepEqual(ctx.incident, { severity: "sev2", status: "investigating", version: 3 });
  });
});
