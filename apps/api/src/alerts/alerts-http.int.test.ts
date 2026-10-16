import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { toErrorResponse } from "../http/error-response";
import { readJsonBody } from "../http/webhook-body";
import { createTestApp, type TestApp } from "../test-support/app-harness";

const LIMIT = 4096;
const PATH = "/api/v1/integrations/alertmanager";

/**
 * The webhook over a REAL HTTP socket: the same handler and body reader the Nest controller uses, mounted on a bare
 * node:http server (the controller itself is a three-line adapter; its Nest wiring is covered by the CI container smoke
 * test). This is where body limits, content types and the status/header contract are checked on the wire.
 */
describe("Alertmanager webhook over HTTP (real PostgreSQL, real socket)", () => {
  let app: TestApp;
  let server: Server;
  let url: string;
  let token: string;
  let bodyReads = 0;

  const STARTS_AT = new Date(Date.now() - 600_000).toISOString();
  const A = (over: Record<string, unknown> = {}) => ({
    status: "firing",
    labels: { alertname: "DiskFull", severity: "error" },
    annotations: { summary: "disk almost full" },
    startsAt: STARTS_AT,
    endsAt: "0001-01-01T00:00:00Z",
    fingerprint: "abcdef0123456789",
    ...over,
  });
  const payload = (alerts: unknown[], over: Record<string, unknown> = {}) => ({ version: "4", status: "firing", groupKey: "{}:{}", truncatedAlerts: 0, receiver: "r", alerts, ...over });

  const post = (body: string | null, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...headers }, body });

  beforeEach(async () => {
    app = await createTestApp();
    const owner = await app.register("http-owner@example.com");
    token = (await app.integrations.create(owner.auth, { name: "http" })).token;
    bodyReads = 0;
    server = createServer((req, res) => {
      void (async () => {
        if (req.method !== "POST" || req.url !== PATH) {
          res.statusCode = 404;
          return res.end();
        }
        try {
          const result = await app.webhook.alertmanager({
            ip: req.socket.remoteAddress ?? "unknown",
            headers: req.headers,
            readJson: () => {
              bodyReads += 1;
              return readJsonBody(req, { limitBytes: LIMIT, timeoutMs: 2000 });
            },
          });
          res.writeHead(result.status, { "content-type": "application/json", ...(result.headers ?? {}) });
          res.end(JSON.stringify(result.body));
        } catch (error) {
          const r = toErrorResponse(error);
          res.writeHead(r.status, { "content-type": "application/json", ...(r.headers ?? {}) });
          res.end(JSON.stringify(r.body));
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${PATH}`;
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.close();
  });

  it("delivers a standard notification: 200 JSON after commit, repeat is a duplicate", async () => {
    const first = await post(JSON.stringify(payload([A()])));
    assert.equal(first.status, 200);
    const json = (await first.json()) as { created: number; results: Array<{ result: string }> };
    assert.equal(json.created, 1);
    const second = await post(JSON.stringify(payload([A()])));
    assert.equal(second.status, 200);
    assert.equal(((await second.json()) as { results: Array<{ result: string }> }).results[0]!.result, "duplicate");
    assert.equal((await app.testDb.query("SELECT 1 FROM incidents")).length, 1);
  });

  it("a body over the webhook limit gets an explicit 413 with remediation (not a framework default), and nothing is written", async () => {
    const huge = JSON.stringify(payload([A({ annotations: { summary: "x".repeat(LIMIT * 2) } })]));
    const r = await post(huge);
    assert.equal(r.status, 413);
    const json = (await r.json()) as { error: { code: string; message: string } };
    assert.equal(json.error.code, "PAYLOAD_TOO_LARGE");
    assert.match(json.error.message, /group_by/);
    assert.equal((await app.testDb.query("SELECT 1 FROM incidents")).length, 0);
    // and the server is still healthy on a new request
    assert.equal((await post(JSON.stringify(payload([A()])))).status, 200);
  });

  it("a chunked body over the limit is also 413", async () => {
    const chunk = "x".repeat(1000);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"a":"'));
        for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode(chunk));
        controller.enqueue(new TextEncoder().encode('"}'));
        controller.close();
      },
    });
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: stream, duplex: "half" } as RequestInit);
    assert.equal(r.status, 413);
  });

  it("an unauthenticated oversized body is rejected with 401 WITHOUT being read", async () => {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(LIMIT * 3) });
    assert.equal(r.status, 401);
    assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer/);
    assert.equal(bodyReads, 0);
  });

  it("wrong content type 415, invalid JSON 400, truncated notification 503 + Retry-After", async () => {
    assert.equal((await post("a=b", { "content-type": "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await post("{broken")).status, 400);
    const truncated = await post(JSON.stringify(payload([A()], { truncatedAlerts: 5 })));
    assert.equal(truncated.status, 503);
    assert.ok(Number(truncated.headers.get("retry-after")) >= 1);
    assert.equal(((await truncated.json()) as { error: { code: string } }).error.code, "ALERTS_TRUNCATED");
    assert.equal((await app.testDb.query("SELECT 1 FROM incidents")).length, 0);
  });

  it("responses are not cacheable and never contain the token", async () => {
    const ok = await post(JSON.stringify(payload([A()])));
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.ok(!(await ok.text()).includes(token));
    const denied = await post("{}", { authorization: `Bearer ${"Z".repeat(43)}` });
    assert.equal(denied.status, 401);
    assert.ok(!(await denied.text()).includes(token));
  });
});
