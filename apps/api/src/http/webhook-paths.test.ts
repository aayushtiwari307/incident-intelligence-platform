import assert from "node:assert/strict";
import { globalJsonParserShouldParse, isWebhookPath } from "./webhook-paths";

describe("which requests the global JSON parser handles", () => {
  const json = { "content-type": "application/json" };

  it("recognises webhook paths regardless of case, query string or trailing slash", () => {
    assert.equal(isWebhookPath("/api/v1/integrations/alertmanager"), true);
    assert.equal(isWebhookPath("/api/v1/integrations/alertmanager/"), true);
    assert.equal(isWebhookPath("/api/v1/integrations/changes"), true);
    assert.equal(isWebhookPath("/API/V1/Integrations/Changes?x=1"), true);
    assert.equal(isWebhookPath("/API/V1/Integrations/Alertmanager?x=1"), true);
    assert.equal(isWebhookPath("/api/incidents"), false);
    assert.equal(isWebhookPath("/api/organization/integrations"), false);
    assert.equal(isWebhookPath(undefined), false);
  });

  it("keeps parsing application/json for browser endpoints (limit unchanged) and skips the webhook", () => {
    assert.equal(globalJsonParserShouldParse({ url: "/api/incidents", headers: json }), true);
    assert.equal(globalJsonParserShouldParse({ url: "/api/incidents", headers: { "content-type": "Application/JSON; charset=utf-8" } }), true);
    assert.equal(globalJsonParserShouldParse({ url: "/api/incidents", headers: { "content-type": "text/plain" } }), false);
    assert.equal(globalJsonParserShouldParse({ url: "/api/incidents", headers: {} }), false);
    assert.equal(globalJsonParserShouldParse({ url: "/api/v1/integrations/alertmanager", headers: json }), false);
    assert.equal(globalJsonParserShouldParse({ url: "/api/v1/integrations/changes", headers: json }), false);
  });
});
