import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { buildPayload, checkResponses, isLoopbackHost, resolveTarget, run } from "./simulate-alertmanager.mjs";

const TOKEN = "T".repeat(43);

test("only loopback destinations are accepted by default", () => {
  for (const h of ["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "LOCALHOST"]) assert.equal(isLoopbackHost(h), true, h);
  for (const h of ["example.com", "10.0.0.1", "192.168.1.5", "128.0.0.1", "127.0.0.1.evil.com", "0.0.0.0", "300.1.1.1"]) assert.equal(isLoopbackHost(h), false, h);
  assert.equal(resolveTarget("http://127.0.0.1:8080"), "http://127.0.0.1:8080/api/v1/integrations/alertmanager");
  assert.throws(() => resolveTarget("https://alerts.example.com"), /non-loopback/);
  assert.equal(resolveTarget("https://alerts.example.com", { allowNonLoopback: true }), "https://alerts.example.com/api/v1/integrations/alertmanager");
  assert.throws(() => resolveTarget("ftp://127.0.0.1"), /http/);
  assert.throws(() => resolveTarget("http://user:pw@127.0.0.1"), /Credentials/);
  assert.throws(() => resolveTarget("not a url"), /valid URL/);
});

test("builds standard v4 payloads with synthetic markers only", () => {
  const p = buildPayload({ status: "firing", fingerprint: "simabc", startsAt: "2026-10-15T10:00:00.000Z" });
  assert.equal(p.version, "4");
  assert.equal(p.truncatedAlerts, 0);
  assert.equal(p.alerts[0].fingerprint, "simabc");
  assert.equal(p.alerts[0].endsAt, "0001-01-01T00:00:00Z");
  assert.equal(p.alerts[0].labels.synthetic, "true");
  assert.match(JSON.stringify(p), /SYNTHETIC/);
  assert.equal(buildPayload({ status: "resolved", fingerprint: "x", startsAt: "a", endsAt: "b" }).alerts[0].endsAt, "b");
});

/** A tiny fake of the documented server contract, so the simulator's logic can be tested without the real API. */
function fakeServer({ duplicateBug = false } = {}) {
  const cycles = new Map();
  let incidents = 0;
  const seenAuth = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seenAuth.push(req.headers.authorization);
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: "UNAUTHENTICATED" } }));
        return;
      }
      const body = JSON.parse(raw);
      const a = body.alerts[0];
      const key = `${a.fingerprint}|${a.startsAt}`;
      let result;
      let cycle = cycles.get(key);
      if (!cycle || (duplicateBug && a.status === "firing" && cycle.count >= 1)) {
        incidents += 1;
        cycle = { id: `inc-${incidents}`, number: incidents, count: 0, state: "firing" };
        cycles.set(key, cycle);
        result = "created";
      } else if (a.status === "resolved") {
        result = cycle.state === "resolved" ? "duplicate_resolved" : "resolved";
        cycle.state = "resolved";
      } else result = "duplicate";
      cycle.count += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ accepted: 1, created: result === "created" ? 1 : 0, resolved: result === "resolved" ? 1 : 0, duplicates: 0, ignored: 0, results: [{ result, incidentId: cycle.id, incidentNumber: cycle.number, deliveryCount: cycle.count }] }));
    });
  });
  return { server, seenAuth, incidents: () => incidents };
}

async function withServer(opts, fn) {
  const fake = fakeServer(opts);
  await new Promise((r) => fake.server.listen(0, "127.0.0.1", r));
  try {
    await fn(`http://127.0.0.1:${fake.server.address().port}`, fake);
  } finally {
    await new Promise((r) => fake.server.close(r));
  }
}

test("passes against a server that follows the contract; creates one incident; never prints the token", async () => {
  await withServer({}, async (baseUrl, fake) => {
    const lines = [];
    const { ok, checks } = await run({ baseUrl, token: TOKEN, log: (l) => lines.push(l) });
    assert.equal(ok, true, lines.join("\n"));
    assert.equal(checks.length, 11);
    assert.equal(fake.incidents(), 1);
    assert.deepEqual(fake.seenAuth, [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${"X".repeat(43)}`]);
    assert.ok(lines.some((line) => /invalid bearer token is rejected/.test(line)));
    assert.ok(!lines.join("\n").includes(TOKEN));
  });
});

test("fails loudly when the server creates a duplicate incident", async () => {
  await withServer({ duplicateBug: true }, async (baseUrl) => {
    const lines = [];
    const { ok } = await run({ baseUrl, token: TOKEN, log: (l) => lines.push(l) });
    assert.equal(ok, false);
    assert.match(lines.join("\n"), /FAIL identical firing delivery was a duplicate/);
  });
});

test("refuses to run without a token or against a remote host, before any request", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("must not be called"); };
  await assert.rejects(run({ baseUrl: "http://127.0.0.1:8080", token: "", fetchImpl, log: () => {} }), /ALERTMANAGER_SIM_TOKEN/);
  await assert.rejects(run({ baseUrl: "http://127.0.0.1:8080", token: "has space", fetchImpl, log: () => {} }), /ALERTMANAGER_SIM_TOKEN/);
  await assert.rejects(run({ baseUrl: "https://prod.example.com", token: TOKEN, fetchImpl, log: () => {} }), /non-loopback/);
  assert.equal(calls, 0);
});

test("network errors are reported without leaking the token", async () => {
  const fetchImpl = async () => { throw new Error(`connect ECONNREFUSED while sending ${TOKEN}`); };
  await assert.rejects(run({ baseUrl: "http://127.0.0.1:1", token: TOKEN, fetchImpl, log: () => {} }), (e) => /request failed/.test(e.message) && !e.message.includes(TOKEN));
});

test("checkResponses rejects a failed cycle and recognizes a real authentication failure", () => {
  const checks = checkResponses([
    { status: 401, json: { error: { code: "UNAUTHENTICATED" } } },
    { status: 401 },
    { status: 401 },
    { status: 401, json: { error: { code: "UNAUTHENTICATED" } } },
  ]);
  assert.ok(checks.some((c) => c.name === "invalid bearer token is rejected (HTTP 401)" && c.ok));
  assert.ok(checks.some((c) => c.name === "invalid bearer token reports UNAUTHENTICATED" && c.ok));
  assert.ok(checks.some((c) => c.name === "firing delivery created exactly one incident" && !c.ok));
});
