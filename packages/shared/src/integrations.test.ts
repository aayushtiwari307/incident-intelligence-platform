import assert from "node:assert/strict";
import { ALERT_DELIVERY_RESULTS, ALERTMANAGER_MAX_ALERTS_PER_REQUEST, MAX_ACTIVE_INTEGRATIONS_PER_ORGANIZATION, createIntegrationSchema } from "./integrations";

describe("integration schemas", () => {
  it("accepts a trimmed name and nothing else (strict: no organization id can be smuggled in)", () => {
    assert.deepEqual(createIntegrationSchema.parse({ name: "  prod alertmanager " }), { name: "prod alertmanager" });
    assert.equal(createIntegrationSchema.safeParse({ name: "x", organizationId: "00000000-0000-0000-0000-000000000000" }).success, false);
    assert.equal(createIntegrationSchema.safeParse({}).success, false);
  });

  it("rejects empty, over-long and control-character names", () => {
    for (const name of ["", "   ", "x".repeat(61), "a\nb", "a\u0000b", "tab\there"]) {
      assert.equal(createIntegrationSchema.safeParse({ name }).success, false, JSON.stringify(name));
    }
    assert.equal(createIntegrationSchema.safeParse({ name: "x".repeat(60) }).success, true);
  });

  it("documents the limits", () => {
    assert.equal(ALERTMANAGER_MAX_ALERTS_PER_REQUEST, 50);
    assert.equal(MAX_ACTIVE_INTEGRATIONS_PER_ORGANIZATION, 20);
    assert.equal(new Set(ALERT_DELIVERY_RESULTS).size, ALERT_DELIVERY_RESULTS.length);
  });
});
