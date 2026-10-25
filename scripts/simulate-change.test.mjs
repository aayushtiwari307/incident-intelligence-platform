import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CHANGE_URL, resolveChangeTarget, simulateChange } from "./simulate-change.mjs";

test("change simulator requires a loopback API target and fixed endpoint", () => {
  assert.equal(resolveChangeTarget(), DEFAULT_CHANGE_URL);
  assert.equal(resolveChangeTarget("http://localhost:3001/api/v1/integrations/changes"), "http://localhost:3001/api/v1/integrations/changes");
  assert.throws(() => resolveChangeTarget("https://production.example/api/v1/integrations/changes"), /non-loopback/);
  assert.throws(() => resolveChangeTarget("http://user:secret@127.0.0.1/api/v1/integrations/changes"), /credentials/);
  assert.throws(() => resolveChangeTarget("http://127.0.0.1/api/v1/integrations/alertmanager"), /must end/);
});

test("change simulator sends a synthetic bearer delivery without logging the token", async () => {
  const messages = [];
  const calls = [];
  const result = await simulateChange({
    token: "synthetic-integration-token", service: "checkout", now: () => new Date("2026-10-24T10:00:00Z"), log: (message) => messages.push(message),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ accepted: true, duplicate: true, changeEventId: "event-123" }), { status: 200 });
    },
  });
  assert.equal(result.duplicate, true);
  assert.equal(calls[0].url, DEFAULT_CHANGE_URL);
  assert.equal(calls[0].options.headers.authorization, "Bearer synthetic-integration-token");
  assert.equal(JSON.stringify(messages).includes("synthetic-integration-token"), false);
  assert.equal(JSON.stringify(calls[0].options.body).includes("checkout"), true);
});
