import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "pg";
import type { AlertWebhookResponse, IntegrationDto } from "@platform/shared";
import { AppError } from "../common/errors";
import { Database } from "../common/sql";
import { IncidentService } from "../incidents/incident.service";
import { toErrorResponse } from "../http/error-response";
import type { HttpRequest, HttpResult } from "../http/http-types";
import { createTestApp, type RegisteredUser, type TestApp } from "../test-support/app-harness";
import { AlertIngestionService, toRetryableFailure } from "./alert-ingestion.service";
import { AlertWebhookHandlers, type WebhookRequest } from "./webhook-handlers";
import { parseAlertmanagerPayload } from "./alertmanager-payload";

// ---------------------------------------------------------------------------------------------------------------------
// helpers

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const startsAtNow = (offsetMs = -10 * 60_000) => new Date(Date.now() + offsetMs).toISOString();

const alert = (over: Record<string, unknown> = {}) => ({
  status: "firing",
  labels: { alertname: "HighLatency", severity: "critical", job: "api" },
  annotations: { summary: "p99 latency above 2s", description: "High for 10 minutes" },
  startsAt: "2026-10-15T10:00:00.123456789Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus.example/graph",
  fingerprint: "3a1b2c3d4e5f6a7b",
  ...over,
});
const body = (alerts: unknown[], over: Record<string, unknown> = {}) => ({
  version: "4",
  groupKey: '{}:{alertname="HighLatency"}',
  truncatedAlerts: 0,
  status: alerts.every((a) => (a as { status: string }).status === "resolved") ? "resolved" : "firing",
  receiver: "incident-platform",
  groupLabels: {},
  commonLabels: {},
  commonAnnotations: {},
  externalURL: "http://alertmanager.example:9093",
  alerts,
  ...over,
});
// startsAt must be inside the validator's window relative to the real clock, so tests use a recent fixed value per run.
const T0 = startsAtNow();
const A = (over: Record<string, unknown> = {}) => alert({ startsAt: T0, ...over });

interface Reply {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any -- test helper: untyped JSON asserted field by field
  headers: Record<string, string>;
}

async function fromResult(fn: Promise<HttpResult>): Promise<Reply> {
  try {
    const r = await fn;
    return { status: r.status, json: r.body, headers: r.headers ?? {} };
  } catch (error) {
    const r = toErrorResponse(error);
    return { status: r.status, json: r.body, headers: r.headers ?? {} };
  }
}

const ORIGIN = "http://localhost:3000";
const cookieHeader = (u: RegisteredUser) => `sid=${encodeURIComponent(u.token)}`;
const mgmt = (u: RegisteredUser | null, over: Partial<HttpRequest> = {}): HttpRequest => ({
  method: "GET",
  ip: "198.51.100.20",
  body: undefined,
  query: {},
  params: {},
  ...over,
  headers: { ...(u ? { cookie: cookieHeader(u) } : {}), origin: ORIGIN, ...(over.headers ?? {}) },
});

describe("Alertmanager integrations and alert ingestion (real PostgreSQL)", () => {
  let app: TestApp;
  let owner: RegisteredUser;
  let integration: IntegrationDto & { token: string };

  const deliver = (token: string | null, payload: unknown, opts: { ip?: string; headers?: Record<string, string>; readJson?: () => Promise<unknown>; handler?: AlertWebhookHandlers } = {}): Promise<Reply> => {
    const req: WebhookRequest = {
      ip: opts.ip ?? "203.0.113.7",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers ?? {}) },
      readJson: opts.readJson ?? (async () => payload),
    };
    return fromResult((opts.handler ?? app.webhook).alertmanager(req));
  };
  const send = (payload: unknown, token = integration.token) => deliver(token, payload);
  const results = (r: Reply) => (r.json as AlertWebhookResponse).results.map((x) => x.result);

  const count = async (table: string, where = "true", params: unknown[] = []) =>
    Number((await app.testDb.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE ${where}`, params))[0]!.n);

  beforeEach(async () => {
    app = await createTestApp();
    owner = await app.register("owner@example.com", "Org A");
    const created = await app.integrations.create(owner.auth, { name: "prod-alertmanager" });
    integration = created;
  });
  afterEach(async () => {
    await app.close();
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("credential management", () => {
    it("owners and admins create, list, rotate and revoke; responders and viewers cannot; the plaintext token is shown once", async () => {
      const admin = await app.join(owner, "admin@example.com", "admin");
      const responder = await app.join(owner, "responder@example.com", "responder");
      const viewer = await app.join(owner, "viewer@example.com", "viewer");

      const made = await app.integrations.create(admin.auth, { name: "second" });
      assert.match(made.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(made.status, "active");
      assert.equal(made.createdBy?.id, admin.auth.userId);

      for (const who of [responder, viewer]) {
        for (const op of [() => app.integrations.list(who.auth), () => app.integrations.create(who.auth, { name: "x" }), () => app.integrations.rotate(who.auth, made.id), () => app.integrations.revoke(who.auth, made.id)]) {
          await assert.rejects(op(), (e: unknown) => e instanceof AppError && e.code === "FORBIDDEN");
        }
      }

      const listed = await app.integrations.list(owner.auth);
      assert.deepEqual(listed.map((i) => i.name).sort(), ["prod-alertmanager", "second"]);
      for (const item of listed) {
        assert.ok(!("token" in item) && !("tokenHash" in item) && !("token_hash" in item));
        assert.ok(!JSON.stringify(item).includes(made.token));
      }

      const rotated = await app.integrations.rotate(owner.auth, made.id);
      assert.equal(rotated.id, made.id);
      assert.notEqual(rotated.token, made.token);
      assert.ok(rotated.rotatedAt);
      assert.equal(rotated.rotatedBy?.id, owner.auth.userId);

      const revoked = await app.integrations.revoke(admin.auth, made.id);
      assert.equal(revoked.status, "revoked");
      assert.equal(revoked.revokedBy?.id, admin.auth.userId);
      assert.equal((await app.integrations.revoke(admin.auth, made.id)).status, "revoked", "revoking twice is idempotent");
      await assert.rejects(app.integrations.rotate(owner.auth, made.id), (e: unknown) => e instanceof AppError && e.code === "CONFLICT");
    });

    it("stores only the SHA-256 hash of the token", async () => {
      const rows = await app.testDb.query<Record<string, unknown>>("SELECT * FROM integrations");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.token_hash, sha256(integration.token));
      assert.ok(!JSON.stringify(rows).includes(integration.token), "the plaintext token appears in no column");
      const rotated = await app.integrations.rotate(owner.auth, integration.id);
      const after = await app.testDb.query<Record<string, unknown>>("SELECT * FROM integrations");
      assert.equal(after[0]!.token_hash, sha256(rotated.token));
      assert.ok(!JSON.stringify(after).includes(integration.token) && !JSON.stringify(after).includes(rotated.token));
    });

    it("is organization-scoped: another organization's admin sees, rotates and revokes nothing of ours", async () => {
      const other = await app.register("other@example.com", "Org B");
      assert.deepEqual(await app.integrations.list(other.auth), []);
      await assert.rejects(app.integrations.rotate(other.auth, integration.id), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
      await assert.rejects(app.integrations.revoke(other.auth, integration.id), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
      await assert.rejects(app.integrations.rotate(other.auth, "not-a-uuid"), (e: unknown) => e instanceof AppError && e.code === "NOT_FOUND");
      assert.equal((await send(body([A()]))).status, 200, "our token still works");
      const sameName = await app.integrations.create(other.auth, { name: "prod-alertmanager" });
      assert.notEqual(sameName.id, integration.id, "names are only unique per organization");
    });

    it("validates names, rejects duplicates among active integrations, and caps active integrations per organization", async () => {
      for (const name of ["", "   ", "x".repeat(61), "bad\nname"]) {
        await assert.rejects(app.integrations.create(owner.auth, { name }), (e: unknown) => e instanceof AppError && e.code === "VALIDATION_FAILED", JSON.stringify(name));
      }
      await assert.rejects(app.integrations.create(owner.auth, { name: "x", organizationId: "00000000-0000-0000-0000-000000000000" }), (e: unknown) => e instanceof AppError && e.code === "VALIDATION_FAILED");
      await assert.rejects(app.integrations.create(owner.auth, { name: "PROD-alertmanager" }), (e: unknown) => e instanceof AppError && e.code === "CONFLICT");
      await app.integrations.revoke(owner.auth, integration.id);
      await app.integrations.create(owner.auth, { name: "prod-alertmanager" }); // a revoked name can be reused
      for (let i = 0; i < 19; i++) await app.integrations.create(owner.auth, { name: `bulk-${i}` });
      await assert.rejects(app.integrations.create(owner.auth, { name: "one-too-many" }), (e: unknown) => e instanceof AppError && e.code === "CONFLICT");
    });

    it("management HTTP handlers keep session + Origin protection and return the token only from create/rotate", async () => {
      const viewer = await app.join(owner, "v@example.com", "viewer");
      assert.equal((await fromResult(app.handlers.createIntegration(mgmt(null, { method: "POST", body: { name: "x" } })))).status, 401);
      assert.equal((await fromResult(app.handlers.createIntegration(mgmt(owner, { method: "POST", body: { name: "x" }, headers: { origin: "https://evil.example" } })))).status, 403);
      assert.equal((await fromResult(app.handlers.createIntegration(mgmt(viewer, { method: "POST", body: { name: "x" } })))).status, 403);

      const created = await fromResult(app.handlers.createIntegration(mgmt(owner, { method: "POST", body: { name: "via-http" } })));
      assert.equal(created.status, 201);
      assert.equal(created.headers["Cache-Control"], "no-store");
      assert.match(created.json.token, /^[A-Za-z0-9_-]{43}$/);

      const listed = await fromResult(app.handlers.listIntegrations(mgmt(owner)));
      assert.equal(listed.status, 200);
      assert.ok(!JSON.stringify(listed.json).includes(created.json.token));

      const rotated = await fromResult(app.handlers.rotateIntegration(mgmt(owner, { method: "POST", params: { id: created.json.id } })));
      assert.equal(rotated.status, 200);
      assert.notEqual(rotated.json.token, created.json.token);
      const revoked = await fromResult(app.handlers.revokeIntegration(mgmt(owner, { method: "DELETE", params: { id: created.json.id } })));
      assert.equal(revoked.status, 200);
      assert.equal(revoked.json.status, "revoked");
      assert.ok(!("token" in revoked.json));
    });

    it("session cookies are not webhook credentials and webhook tokens are not session credentials", async () => {
      const r = await deliver(null, body([A()]), { headers: { cookie: cookieHeader(owner) } });
      assert.equal(r.status, 401);
      const asSession = await fromResult(app.handlers.me({ ...mgmt(null), headers: { cookie: `sid=${integration.token}`, origin: ORIGIN } }));
      assert.equal(asSession.status, 401);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("webhook authentication", () => {
    it("rejects missing, malformed, unknown, revoked and query-string credentials with 401 and never echoes a secret", async () => {
      const unknown = "A".repeat(43);
      const cases: Array<[string, Reply]> = [
        ["no header", await deliver(null, body([A()]))],
        ["basic scheme", await deliver(null, body([A()]), { headers: { authorization: `Basic ${integration.token}` } })],
        ["no space", await deliver(null, body([A()]), { headers: { authorization: `Bearer${integration.token}` } })],
        ["double space", await deliver(null, body([A()]), { headers: { authorization: `Bearer  ${integration.token}` } })],
        ["too short", await deliver("short", body([A()]))],
        ["bad charset", await deliver(`${integration.token.slice(0, 40)}!!!`, body([A()]))],
        ["unknown", await deliver(unknown, body([A()]))],
      ];
      for (const [name, r] of cases) {
        assert.equal(r.status, 401, name);
        assert.equal(r.json.error.code, "UNAUTHENTICATED", name);
        assert.match(r.headers["WWW-Authenticate"] ?? "", /^Bearer/, name);
        assert.ok(!JSON.stringify(r.json).includes(integration.token), name);
      }
      const viaQuery = await fromResult(app.webhook.alertmanager({ ip: "203.0.113.9", headers: {}, readJson: async () => body([A()]), query: { token: integration.token } } as WebhookRequest));
      assert.equal(viaQuery.status, 401);

      await app.integrations.revoke(owner.auth, integration.id);
      const revoked = await send(body([A()]));
      assert.equal(revoked.status, 401);
      assert.equal(await count("incidents"), 0);
    });

    it("an unauthenticated request never reaches the body reader or the database transaction", async () => {
      let reads = 0;
      const r = await deliver("B".repeat(43), null, { readJson: async () => { reads++; return {}; } });
      assert.equal(r.status, 401);
      assert.equal(reads, 0);
    });

    it("rotation: the old token stops working at once, the new one works, and the dedupe identity is preserved", async () => {
      const first = await send(body([A()]));
      assert.equal(first.status, 200);
      assert.deepEqual(results(first), ["created"]);
      const rotated = await app.integrations.rotate(owner.auth, integration.id);
      assert.equal((await send(body([A()]), integration.token)).status, 401, "old token rejected immediately");
      const again = await send(body([A()]), rotated.token);
      assert.equal(again.status, 200);
      assert.deepEqual(results(again), ["duplicate"], "same integration id => same cycle => no second incident");
      assert.equal(again.json.results[0].deliveryCount, 2);
      assert.equal(await count("incidents"), 1);
      assert.equal(await count("alert_cycles"), 1);
    });

    it("a revoke that completes before the transaction starts wins; a revoke during a delivery waits for it (no half-validated writes)", async () => {
      // (a) credential looked up, then revoked, then the transaction runs: rejected, nothing written.
      const looked = (await app.ingestion.authenticate(integration.token))!;
      await app.integrations.revoke(owner.auth, integration.id);
      await assert.rejects(app.ingestion.ingest(looked, parseAlertmanagerPayload(body([A()]))), (e: unknown) => e instanceof AppError && e.code === "UNAUTHENTICATED");
      assert.equal(await count("incidents"), 0);

      // (b) a delivery transaction holding its FOR SHARE lock blocks a concurrent revoke until it commits.
      const second = await app.integrations.create(owner.auth, { name: "second" });
      const live = (await app.ingestion.authenticate(second.token))!;
      let revokeDone = false;
      let revoking: Promise<unknown> = Promise.resolve();
      await app.database.tx(async (tx) => {
        await tx.query("SELECT 1 FROM integrations WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL FOR SHARE", [live.id, live.tokenHash]);
        revoking = app.integrations.revoke(owner.auth, second.id).then(() => (revokeDone = true));
        await new Promise((r) => setTimeout(r, 300));
        assert.equal(revokeDone, false, "revoke must wait for the in-flight delivery");
      });
      await revoking;
      assert.equal(revokeDone, true);
      assert.equal((await send(body([A()]), second.token)).status, 401);
    });

    it("records last_used_at after a committed delivery", async () => {
      assert.equal((await app.integrations.list(owner.auth))[0]!.lastUsedAt, null);
      await send(body([A()]));
      assert.ok((await app.integrations.list(owner.auth))[0]!.lastUsedAt);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("payload validation and limits (no partial writes)", () => {
    const nothingWritten = async () => {
      assert.equal(await count("incidents"), 0);
      assert.equal(await count("alert_cycles"), 0);
      assert.equal(await count("incident_events"), 0);
      assert.equal(await count("incident_counters"), 0, "not even the incident number counter moved");
    };

    it("accepts standard v4 firing and resolved notifications", async () => {
      const firing = await send(body([A()]));
      assert.equal(firing.status, 200);
      assert.deepEqual({ ...firing.json, results: undefined }, { accepted: 1, created: 1, resolved: 0, duplicates: 0, ignored: 0, results: undefined });
      const resolved = await send(body([A({ status: "resolved", endsAt: startsAtNow(-60_000) })], { status: "resolved", notification_reason: "resolved_alert" }));
      assert.equal(resolved.status, 200);
      assert.equal(resolved.json.resolved, 1);
    });

    it("rejects unsupported versions, malformed fields and bad timestamps/fingerprints with 400 and writes nothing", async () => {
      const bad: unknown[] = [
        { ...body([A()]), version: "3" },
        { ...body([A()]), version: undefined },
        body([]),
        body([A({ fingerprint: "has space" })]),
        body([A({ fingerprint: undefined })]),
        body([A({ startsAt: "yesterday" })]),
        body([A({ startsAt: "0001-01-01T00:00:00Z" })]),
        body([A({ startsAt: "2999-01-01T00:00:00Z" })]),
        body([A({ status: "weird" })]),
        body([A({ labels: { "bad name": "v" } })]),
        body([A({ labels: { alertname: "x".repeat(1025) } })]),
        body([A({ annotations: { summary: "x".repeat(4097) } })]),
        body([A({ labels: JSON.parse('{"__proto__":"x"}') as unknown })]),
        [],
        "string",
      ];
      for (const payload of bad) {
        const r = await send(payload);
        assert.equal(r.status, 400, JSON.stringify(payload).slice(0, 80));
        assert.equal(r.json.error.code, "VALIDATION_FAILED");
      }
      await nothingWritten();
    });

    it("one invalid alert rejects the whole request: the valid alert before it is not created", async () => {
      const r = await send(body([A({ fingerprint: "aaa" }), A({ fingerprint: "bbb", startsAt: "nope" })]));
      assert.equal(r.status, 400);
      await nothingWritten();
    });

    it("more than 50 alerts is 413 and the 50-alert boundary is accepted", async () => {
      const many = Array.from({ length: 51 }, (_, i) => A({ fingerprint: `fp${i}` }));
      const r = await send(body(many));
      assert.equal(r.status, 413);
      assert.equal(r.json.error.code, "PAYLOAD_TOO_LARGE");
      await nothingWritten();
      const ok = await send(body(many.slice(0, 50)));
      assert.equal(ok.status, 200);
      assert.equal(ok.json.created, 50);
      assert.equal(await count("incidents"), 50);
    });

    it("truncatedAlerts > 0 is a retryable 503 with Retry-After and remediation; nothing is processed", async () => {
      const r = await send(body([A()], { truncatedAlerts: 2 }));
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, "ALERTS_TRUNCATED");
      assert.ok(Number(r.headers["Retry-After"]) >= 1);
      assert.match(r.json.error.message, /max_alerts/);
      await nothingWritten();
    });

    it("an oversized body (413) and non-JSON bodies are reported with their own errors, after authentication", async () => {
      const tooLarge = await deliver(integration.token, null, {
        readJson: async () => { throw new AppError("PAYLOAD_TOO_LARGE", "too big", { headers: { Connection: "close" } }); },
      });
      assert.equal(tooLarge.status, 413);
      const notJson = await deliver(integration.token, null, { readJson: async () => { throw new AppError("UNSUPPORTED_MEDIA_TYPE", "no"); } });
      assert.equal(notJson.status, 415);
      await nothingWritten();
    });

    it("never persists the raw body, arbitrary labels/annotations or links", async () => {
      const marker = "SENTINEL-DO-NOT-STORE";
      const r = await send(
        body([A({ labels: { alertname: "Disk", severity: "warning", secret_label: marker }, annotations: { summary: "disk", runbook_url: `http://x/${marker}`, other: marker }, generatorURL: `http://x/${marker}` })], {
          commonLabels: { x: marker }, externalURL: `http://x/${marker}`, receiver: marker,
        }),
      );
      assert.equal(r.status, 200);
      const dump = JSON.stringify([
        await app.testDb.query("SELECT * FROM incidents"),
        await app.testDb.query("SELECT * FROM incident_events"),
        await app.testDb.query("SELECT * FROM alert_cycles"),
        await app.testDb.query("SELECT * FROM integrations"),
      ]);
      assert.ok(!dump.includes(marker));
    });

    it("maps severity deterministically onto sev1-sev4 (unknown/missing => sev3)", async () => {
      const labels = (severity?: string, i = 0) => ({ fingerprint: `sev${i}`, labels: { alertname: `A${i}`, ...(severity === undefined ? {} : { severity }) } });
      await send(body([A(labels("critical", 1)), A(labels("error", 2)), A(labels("warning", 3)), A(labels("info", 4)), A(labels("bogus", 5)), A(labels(undefined, 6))]));
      const rows = await app.testDb.query<{ title: string; severity: string }>("SELECT title, severity FROM incidents ORDER BY title");
      assert.deepEqual(rows.map((r) => `${r.title.split(":")[0]}:${r.severity}`), ["A1:sev1", "A2:sev2", "A3:sev3", "A4:sev4", "A5:sev3", "A6:sev3"]);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("idempotency and lifecycle", () => {
    it("creates one incident (with its timeline entry) in the integration's organization, attributed to the integration", async () => {
      const r = await send(body([A()]));
      assert.equal(r.status, 200);
      const [inc] = await app.testDb.query<{ id: string; organization_id: string; created_by: string | null; title: string; status: string; severity: string; number: number }>("SELECT * FROM incidents");
      assert.equal(inc!.organization_id, owner.auth.organizationId);
      assert.equal(inc!.created_by, null);
      assert.equal(inc!.status, "triggered");
      assert.equal(inc!.severity, "sev1");
      assert.equal(inc!.title, "HighLatency: p99 latency above 2s");
      assert.equal(r.json.results[0].incidentId, inc!.id);
      assert.equal(r.json.results[0].incidentNumber, 1);
      const events = await app.testDb.query<{ type: string; actor_id: string | null; actor_label: string; payload: Record<string, unknown> }>("SELECT * FROM incident_events");
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, "created");
      assert.equal(events[0]!.actor_id, null);
      assert.equal(events[0]!.actor_label, "alertmanager: prod-alertmanager");
      assert.equal(events[0]!.payload.source, "alertmanager");
      const [cycle] = await app.testDb.query<{ integration_id: string; fingerprint: string; starts_at: Date; delivery_count: number; state: string }>("SELECT * FROM alert_cycles");
      assert.equal(cycle!.integration_id, integration.id);
      assert.equal(cycle!.state, "firing");
      assert.equal(cycle!.delivery_count, 1);
      // visible through the normal tenant-scoped API
      assert.equal((await app.incidents.get(owner.auth, inc!.id)).title, inc!.title);
    });

    it("an identical retry creates one incident, counts the delivery and appends no timeline entry", async () => {
      await send(body([A()]));
      const [before] = await app.testDb.query<{ version: number; updated_at: Date }>("SELECT version, updated_at FROM incidents");
      const again = await send(body([A()]));
      const third = await send(body([A()]));
      assert.deepEqual(results(again), ["duplicate"]);
      assert.equal(third.json.results[0].deliveryCount, 3);
      assert.equal(await count("incidents"), 1);
      assert.equal(await count("incident_events"), 1, "repeats are not timeline noise");
      const [after] = await app.testDb.query<{ version: number }>("SELECT version FROM incidents");
      assert.equal(after!.version, before!.version, "the incident is not touched by a repeat");
      const [cycle] = await app.testDb.query<{ delivery_count: number; last_seen_at: Date; first_seen_at: Date }>("SELECT * FROM alert_cycles");
      assert.equal(cycle!.delivery_count, 3);
      assert.ok(cycle!.last_seen_at.getTime() >= cycle!.first_seen_at.getTime());
    });

    it("two spellings of the same startsAt (offset vs Z, extra nanoseconds) are the same cycle", async () => {
      await send(body([A({ startsAt: "2026-10-15T10:00:00.123456789Z" })]));
      const r = await send(body([A({ startsAt: "2026-10-15T15:30:00.123456+05:30" })]));
      assert.deepEqual(results(r), ["duplicate"]);
      assert.equal(await count("incidents"), 1);
    });

    it("concurrent duplicate deliveries create exactly one incident", async () => {
      const replies = await Promise.all(Array.from({ length: 10 }, () => send(body([A()]))));
      assert.ok(replies.every((r) => r.status === 200), JSON.stringify(replies.map((r) => r.status)));
      assert.equal(replies.flatMap(results).filter((x) => x === "created").length, 1);
      assert.equal(replies.flatMap(results).filter((x) => x === "duplicate").length, 9);
      assert.equal(await count("incidents"), 1);
      assert.equal(await count("alert_cycles"), 1);
      assert.equal(await count("incident_events"), 1);
      assert.equal(Number((await app.testDb.query<{ n: number }>("SELECT delivery_count AS n FROM alert_cycles"))[0]!.n), 10);
    });

    it("concurrent overlapping batches (different orders and mixes) neither deadlock nor duplicate", async () => {
      const fps = ["f1", "f2", "f3", "f4", "f5"];
      const mk = (order: string[]) => body(order.map((fp) => A({ fingerprint: fp })));
      const batches = [mk(fps), mk([...fps].reverse()), mk(["f3", "f1", "f5", "f2", "f4"]), mk(["f2", "f4"]), mk(["f5", "f1"])];
      const replies = await Promise.all([...batches, ...batches].map((b) => send(b)));
      assert.ok(replies.every((r) => r.status === 200), JSON.stringify(replies.map((r) => r.status)));
      assert.equal(await count("incidents"), 5);
      assert.equal(await count("alert_cycles"), 5);
      const numbers = await app.testDb.query<{ number: number }>("SELECT number FROM incidents ORDER BY number");
      assert.deepEqual(numbers.map((n) => Number(n.number)), [1, 2, 3, 4, 5]);
    });

    it("firing -> resolved resolves the incident once, with one status entry; repeated resolved is idempotent", async () => {
      await send(body([A()]));
      const resolvedBody = body([A({ status: "resolved", endsAt: startsAtNow(-30_000) })]);
      const r = await send(resolvedBody);
      assert.deepEqual(results(r), ["resolved"]);
      const [inc] = await app.testDb.query<{ status: string; resolved_at: Date | null; version: number }>("SELECT status, resolved_at, version FROM incidents");
      assert.equal(inc!.status, "resolved");
      assert.ok(inc!.resolved_at);
      assert.equal(Number(inc!.version), 2);
      const events = await app.testDb.query<{ type: string; actor_id: string | null; actor_label: string; payload: { from: string; to: string; source: string } }>("SELECT * FROM incident_events ORDER BY id");
      assert.deepEqual(events.map((e) => e.type), ["created", "status_changed"]);
      assert.deepEqual({ from: events[1]!.payload.from, to: events[1]!.payload.to, source: events[1]!.payload.source }, { from: "triggered", to: "resolved", source: "alertmanager" });
      assert.equal(events[1]!.actor_id, null);

      const again = await send(resolvedBody);
      const thrice = await send(resolvedBody);
      assert.deepEqual(results(again), ["duplicate_resolved"]);
      assert.deepEqual(results(thrice), ["duplicate_resolved"]);
      assert.equal(await count("incident_events"), 2);
      assert.equal(Number((await app.testDb.query<{ version: number }>("SELECT version FROM incidents"))[0]!.version), 2);
      assert.equal(await count("alert_cycles", "state = 'resolved' AND resolved_at IS NOT NULL"), 1);
    });

    it("firing and resolved for the same cycle in ONE request: processed in order, one incident, resolved", async () => {
      const r = await send(body([A({ status: "resolved" }), A()]));
      assert.equal(r.status, 200);
      assert.deepEqual(results(r), ["created", "resolved"], "firing sorts before resolved");
      assert.equal(await count("incidents", "status = 'resolved'"), 1);
    });

    it("a new startsAt is a new cycle with its own incident", async () => {
      await send(body([A()]));
      await send(body([A({ status: "resolved" })]));
      const second = await send(body([A({ startsAt: startsAtNow(-5 * 60_000 + 1000) })]));
      assert.deepEqual(results(second), ["created"]);
      assert.equal(await count("incidents"), 2);
      assert.equal(await count("alert_cycles"), 2);
      assert.equal((await app.testDb.query<{ n: number }>("SELECT max(number) AS n FROM incidents"))[0]!.n, 2);
    });

    it("never overwrites human-edited fields on duplicate delivery or on resolution", async () => {
      await send(body([A()]));
      const [inc] = await app.testDb.query<{ id: string; version: number }>("SELECT id, version FROM incidents");
      await app.incidents.update(owner.auth, inc!.id, { expectedVersion: Number(inc!.version), title: "Human title", description: "Human notes", severity: "sev4", assigneeId: owner.auth.userId });
      await app.incidents.transition(owner.auth, inc!.id, { to: "acknowledged", expectedVersion: 2 });
      const snapshot = await app.testDb.query("SELECT title, description, severity, assignee_id, status, version FROM incidents");

      await send(body([A()]));
      await send(body([A({ annotations: { summary: "changed upstream" }, labels: { alertname: "Renamed", severity: "critical" } })]));
      assert.deepEqual(await app.testDb.query("SELECT title, description, severity, assignee_id, status, version FROM incidents"), snapshot);

      await send(body([A({ status: "resolved" })]));
      const [after] = await app.testDb.query<{ title: string; description: string; severity: string; assignee_id: string; status: string }>("SELECT * FROM incidents");
      assert.equal(after!.status, "resolved");
      assert.deepEqual([after!.title, after!.description, after!.severity, after!.assignee_id], ["Human title", "Human notes", "sev4", owner.auth.userId]);
    });

    it("a resolved-before-firing tombstone blocks late firing without preventing a new cycle", async () => {
      const resolved = await send(body([A({ status: "resolved" })]));
      assert.equal(resolved.status, 200);
      assert.deepEqual(results(resolved), ["ignored_unknown_resolution"]);
      assert.equal(resolved.json.ignored, 1);
      assert.equal(resolved.json.results[0].incidentId, null);
      assert.equal(await count("incidents"), 0);
      assert.equal(await count("incident_events"), 0);

      const [tombstone] = await app.testDb.query<{ incident_id: string | null; state: string; resolved_at: Date | null; delivery_count: number }>(
        "SELECT incident_id, state, resolved_at, delivery_count FROM alert_cycles WHERE fingerprint = $1 AND starts_at = $2::timestamptz",
        ["3a1b2c3d4e5f6a7b", T0],
      );
      assert.ok(tombstone, "the unseen resolved cycle must be persisted");
      assert.equal(tombstone!.incident_id, null, "a tombstone must not fabricate an incident reference");
      assert.equal(tombstone!.state, "resolved");
      assert.ok(tombstone!.resolved_at);
      assert.equal(tombstone!.delivery_count, 1);

      const lateFiring = await send(body([A()]));
      assert.deepEqual(results(lateFiring), ["ignored_stale_firing"]);
      assert.equal(lateFiring.json.results[0].incidentId, null);
      assert.equal(lateFiring.json.results[0].incidentNumber, null);
      assert.equal(lateFiring.json.results[0].deliveryCount, 2);
      assert.equal(await count("incidents"), 0, "late firing must not open a phantom incident");

      const repeatedResolution = await send(body([A({ status: "resolved" })]));
      assert.deepEqual(results(repeatedResolution), ["duplicate_resolved"]);
      assert.equal(repeatedResolution.json.results[0].incidentId, null);
      assert.equal(repeatedResolution.json.results[0].deliveryCount, 3);

      const newCycle = await send(body([A({ startsAt: startsAtNow(-5 * 60_000) })]));
      assert.deepEqual(results(newCycle), ["created"], "a new startsAt remains a distinct legitimate cycle");
      assert.equal(await count("incidents"), 1);
      assert.equal(await count("alert_cycles"), 2);
    });

    it("concurrent repeats after an unseen resolution cannot create or reopen an incident", async () => {
      await send(body([A({ status: "resolved" })])); // establish the tombstone before the concurrent delivery burst
      const requests = Array.from({ length: 16 }, (_, index) =>
        index % 2 === 0 ? send(body([A()])) : send(body([A({ status: "resolved" })])),
      );
      const replies = await Promise.all(requests);
      assert.ok(replies.every((reply) => reply.status === 200));
      assert.ok(replies.every((reply) => ["ignored_stale_firing", "duplicate_resolved"].includes(results(reply)[0]!)));
      assert.equal(await count("incidents"), 0);
      assert.equal(await count("incident_events"), 0);
      assert.equal(await count("alert_cycles", "incident_id IS NULL AND state = 'resolved'"), 1);
      assert.equal(await count("alert_cycles"), 1);
    });

    it("a stale or replayed firing delivery never reopens a resolved cycle", async () => {
      await send(body([A()]));
      await send(body([A({ status: "resolved" })]));
      const stale = await send(body([A()]));
      assert.deepEqual(results(stale), ["ignored_stale_firing"]);
      assert.equal(stale.json.results[0].deliveryCount, 3);
      assert.equal(await count("incidents"), 1);
      assert.equal(await count("incidents", "status = 'resolved'"), 1);
      assert.equal(await count("incident_events"), 2);
      assert.equal(await count("alert_cycles", "state = 'resolved'"), 1);
    });

    it("resolving an incident a human already resolved adds no event; one a human reopened is resolved again", async () => {
      await send(body([A({ fingerprint: "h1" }), A({ fingerprint: "h2" })]));
      const rows = await app.testDb.query<{ id: string; title: string; fingerprint: string }>(
        "SELECT i.id, i.title, c.fingerprint FROM incidents i JOIN alert_cycles c ON c.incident_id = i.id ORDER BY c.fingerprint");
      const [h1, h2] = rows;
      await app.incidents.transition(owner.auth, h1!.id, { to: "resolved", expectedVersion: 1 });
      await app.incidents.transition(owner.auth, h2!.id, { to: "resolved", expectedVersion: 1 });
      await app.incidents.transition(owner.auth, h2!.id, { to: "investigating", expectedVersion: 2 });
      const eventsBefore = await count("incident_events");
      const r = await send(body([A({ fingerprint: "h1", status: "resolved" }), A({ fingerprint: "h2", status: "resolved" })]));
      assert.equal(r.status, 200);
      assert.equal(await count("incident_events"), eventsBefore + 1, "only the reopened incident gets a new entry");
      assert.equal(await count("incidents", "status = 'resolved'"), 2);
      assert.equal(await count("alert_cycles", "state = 'resolved'"), 2);
    });

    it("the same fingerprint and startsAt stay isolated across organizations and across integrations", async () => {
      const other = await app.register("other@example.com", "Org B");
      const otherIntegration = await app.integrations.create(other.auth, { name: "other-am" });
      const secondInOrgA = await app.integrations.create(owner.auth, { name: "second-am" });
      const payload = body([A()]);
      assert.deepEqual(results(await send(payload)), ["created"]);
      assert.deepEqual(results(await send(payload, otherIntegration.token)), ["created"]);
      assert.deepEqual(results(await send(payload, secondInOrgA.token)), ["created"]);
      assert.equal(await count("incidents"), 3);
      assert.equal(await count("incidents", "organization_id = $1", [owner.auth.organizationId]), 2);
      assert.equal(await count("incidents", "organization_id = $1", [other.auth.organizationId]), 1);
      // resolving through one integration only touches its own cycle
      await send(body([A({ status: "resolved" })]), otherIntegration.token);
      assert.equal(await count("incidents", "status = 'resolved'"), 1);
      assert.equal(await count("incidents", "status = 'resolved' AND organization_id = $1", [other.auth.organizationId]), 1);
      // the other organization cannot read ours
      assert.equal((await app.incidents.list(other.auth, {})).items.length, 1);
    });

    it("tenant comes from the credential only: organizationId / receiver / labels in the payload change nothing", async () => {
      const other = await app.register("other@example.com", "Org B");
      const r = await send(body([A({ labels: { alertname: "X", organizationId: String(other.auth.organizationId), organization_id: String(other.auth.organizationId) } })], {
        organizationId: other.auth.organizationId, receiver: String(other.auth.organizationId),
      }));
      // `organizationId` as a LABEL NAME is valid syntax, but it is ignored; as a top-level field it is stripped.
      assert.equal(r.status, 200);
      assert.equal(await count("incidents", "organization_id = $1", [owner.auth.organizationId]), 1);
      assert.equal(await count("incidents", "organization_id = $1", [other.auth.organizationId]), 0);
    });

    it("a failure anywhere in a batch leaves no partial writes, and the sender's retry succeeds", async () => {
      class FailingSecond extends IncidentService {
        private calls = 0;
        override async createFromAlert(...args: Parameters<IncidentService["createFromAlert"]>) {
          this.calls += 1;
          if (this.calls === 2) throw new Error("injected failure");
          return super.createFromAlert(...args);
        }
      }
      const failing = new AlertWebhookHandlers(new AlertIngestionService(app.database, new FailingSecond(app.database)), {
        ipLimiter: app.webhookLimiters.ip, failedAuthLimiter: app.webhookLimiters.failedAuth, integrationLimiter: app.webhookLimiters.integration,
      });
      const payload = body([A({ fingerprint: "aaa" }), A({ fingerprint: "bbb" }), A({ fingerprint: "ccc" })]);
      const failed = await deliver(integration.token, payload, { handler: failing });
      assert.equal(failed.status, 500, "unknown failures are 5xx, which Alertmanager retries");
      assert.equal(await count("incidents"), 0);
      assert.equal(await count("alert_cycles"), 0);
      assert.equal(await count("incident_events"), 0);
      assert.equal(await count("incident_counters"), 0, "the incident number counter rolled back too");

      const retried = await send(payload);
      assert.equal(retried.status, 200);
      assert.equal(retried.json.created, 3);
      const numbers = await app.testDb.query<{ number: number }>("SELECT number FROM incidents ORDER BY number");
      assert.deepEqual(numbers.map((n) => Number(n.number)), [1, 2, 3], "no gaps");
    });

    it("an uncertain commit (response lost) is safe: the retry is a no-op apart from counters", async () => {
      const lost = await send(body([A()])); // imagine the connection dropped before the sender saw this 200
      assert.equal(lost.status, 200);
      const retry = await send(body([A()]));
      assert.equal(retry.status, 200);
      assert.deepEqual(results(retry), ["duplicate"]);
      assert.equal(await count("incidents"), 1);
      assert.equal(await count("incident_events"), 1);
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("operational behaviour", () => {
    it("rate limits answer 503 + Retry-After (never 429, which Alertmanager does not retry) per integration and per address", async () => {
      const limited = await createTestApp({ webhookLimits: { integration: 2, ip: 1000 } });
      try {
        const o = await limited.register("rl@example.com");
        const i = await limited.integrations.create(o.auth, { name: "rl" });
        const go = () => fromResult(limited.webhook.alertmanager({ ip: "203.0.113.50", headers: { authorization: `Bearer ${i.token}` }, readJson: async () => body([A()]) }));
        assert.equal((await go()).status, 200);
        assert.equal((await go()).status, 200);
        const third = await go();
        assert.equal(third.status, 503);
        assert.notEqual(third.status, 429);
        assert.equal(third.json.error.code, "SERVICE_UNAVAILABLE");
        assert.ok(Number(third.headers["Retry-After"]) >= 1);
        assert.equal(Number((await limited.testDb.query<{ n: string }>("SELECT delivery_count AS n FROM alert_cycles"))[0]!.n), 2, "the rejected delivery was not processed");
      } finally {
        await limited.close();
      }
      const ipLimited = await createTestApp({ webhookLimits: { ip: 1 } });
      try {
        const go = () => fromResult(ipLimited.webhook.alertmanager({ ip: "203.0.113.51", headers: {}, readJson: async () => ({}) }));
        assert.equal((await go()).status, 401);
        const second = await go();
        assert.equal(second.status, 503);
        assert.ok(second.headers["Retry-After"]);
      } finally {
        await ipLimited.close();
      }
    });

    it("repeated invalid credentials from one address stop costing database work", async () => {
      const limited = await createTestApp({ webhookLimits: { failedAuth: 3 } });
      try {
        const o = await limited.register("fa@example.com");
        const good = await limited.integrations.create(o.auth, { name: "fa" });
        let queries = 0;
        const original = limited.database.query.bind(limited.database);
        limited.database.query = ((text: string, params?: readonly unknown[]) => { queries++; return original(text, params); }) as typeof limited.database.query;
        const attempt = (ip: string, token: string) => fromResult(limited.webhook.alertmanager({ ip, headers: { authorization: `Bearer ${token}` }, readJson: async () => body([A()]) }));
        for (let i = 0; i < 3; i++) assert.equal((await attempt("203.0.113.60", `${"C".repeat(42)}${i}`)).status, 401);
        const queriesBefore = queries;
        const blocked = await attempt("203.0.113.60", "D".repeat(43));
        assert.equal(blocked.status, 503);
        assert.ok(blocked.headers["Retry-After"]);
        assert.equal(queries, queriesBefore, "no lookup happened for the blocked address");
        assert.equal((await attempt("203.0.113.61", good.token)).status, 200, "other addresses are unaffected");
      } finally {
        await limited.close();
      }
    });

    it("database unavailable / lock timeouts / deadlocks map to a retryable 503", async () => {
      const refusing = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
      const down = new Database({ query: async () => { throw refusing; }, connect: async () => { throw refusing; }, end: async () => undefined });
      const handler = new AlertWebhookHandlers(new AlertIngestionService(down, app.incidents), {
        ipLimiter: app.webhookLimiters.ip, failedAuthLimiter: app.webhookLimiters.failedAuth, integrationLimiter: app.webhookLimiters.integration,
      });
      const r = await deliver(integration.token, body([A()]), { handler });
      assert.equal(r.status, 503);
      assert.equal(r.json.error.code, "SERVICE_UNAVAILABLE");
      assert.ok(Number(r.headers["Retry-After"]) >= 1);
      assert.ok(!JSON.stringify(r.json).includes("ECONNREFUSED"), "driver details are not leaked");

      for (const code of ["55P03", "40P01", "40001", "57P03", "08006", "53300", "57014"]) {
        const mapped = toRetryableFailure(Object.assign(new Error("x"), { code }));
        assert.ok(mapped instanceof AppError && mapped.status === 503 && mapped.headers?.["Retry-After"], code);
      }
      assert.ok(!(toRetryableFailure(Object.assign(new Error("x"), { code: "23505" })) instanceof AppError), "a constraint violation is a bug, not a transient failure");
      assert.ok(toRetryableFailure(new Error("timeout exceeded when trying to connect")) instanceof AppError);
    });

    it("a real transaction failure inside the database (statement error) rolls back and is reported as 5xx", async () => {
      await app.testDb.query("CREATE FUNCTION boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$");
      await app.testDb.query("CREATE TRIGGER boom BEFORE INSERT ON alert_cycles FOR EACH ROW EXECUTE FUNCTION boom()");
      const r = await send(body([A()]));
      assert.equal(r.status, 500);
      assert.equal(await count("incidents"), 0);
      assert.equal(await count("incident_events"), 0);
      await app.testDb.query("DROP TRIGGER boom ON alert_cycles");
      assert.equal((await send(body([A()]))).status, 200);
    });

    it("does not log credentials or payload content", async () => {
      const lines: string[] = [];
      const logger = { info: (m: string, f?: unknown) => void lines.push(JSON.stringify([m, f])), warn: (m: string, f?: unknown) => void lines.push(JSON.stringify([m, f])) };
      const handler = new AlertWebhookHandlers(app.ingestion, {
        ipLimiter: app.webhookLimiters.ip, failedAuthLimiter: app.webhookLimiters.failedAuth, integrationLimiter: app.webhookLimiters.integration, log: logger,
      });
      await deliver(integration.token, body([A({ labels: { alertname: "LEAKCHECK-LABEL" }, annotations: { summary: "LEAKCHECK-SUMMARY" } })]), { handler });
      await deliver("E".repeat(43), body([A()]), { handler });
      assert.ok(lines.length >= 1);
      for (const line of lines) {
        assert.ok(!line.includes(integration.token) && !line.includes("LEAKCHECK") && !line.includes("authorization"), line);
      }
    });

    it("pushes a real-time notification for created and resolved entries, and none for repeats", async () => {
      const listener = new Client({ connectionString: app.testDb.connectionString });
      await listener.connect();
      const seen: Array<{ id: number; o: string }> = [];
      listener.on("notification", (n: { channel: string; payload?: string }) => {
        if (n.channel === "incident_events" && n.payload) seen.push(JSON.parse(n.payload) as { id: number; o: string });
      });
      try {
        await listener.query("LISTEN incident_events");
        const settle = () => new Promise((r) => setTimeout(r, 300));
        await send(body([A()]));
        await settle();
        assert.equal(seen.length, 1);
        assert.equal(seen[0]!.o, owner.auth.organizationId);
        await send(body([A()]));
        await send(body([A()]));
        await settle();
        assert.equal(seen.length, 1, "duplicates are silent");
        await send(body([A({ status: "resolved" })]));
        await settle();
        assert.equal(seen.length, 2);
        // and the existing loader turns each notification into the organization-filtered message the hub broadcasts
        const message = await app.incidents.loadRealtimeMessage(owner.auth.organizationId as string, seen[1]!.id);
        assert.equal(message?.incident.status, "resolved");
        assert.equal(message?.event.type, "status_changed");
        assert.equal(await app.incidents.loadRealtimeMessage("00000000-0000-0000-0000-000000000000", seen[1]!.id), null);
      } finally {
        await listener.end();
      }
    });
  });

  // ------------------------------------------------------------------------------------------------------------------
  describe("database constraints (real PostgreSQL)", () => {
    /** Runs statements in one transaction, rolls back, and returns the SQLSTATE of the first failure ("ok" if none). */
    async function sqlState(statements: Array<[string, unknown[]?]>): Promise<string> {
      const session = await app.testDb.connect();
      try {
        await session.query("BEGIN");
        try {
          for (const [sql, params] of statements) await session.query(sql, params);
          await session.query("SET CONSTRAINTS ALL IMMEDIATE");
          return "ok";
        } catch (error) {
          return (error as { code?: string }).code ?? "unknown";
        } finally {
          await session.query("ROLLBACK");
        }
      } finally {
        await session.close();
      }
    }

    let incidentId: string;
    /** An incident of org A that has no cycle yet, so foreign-key tests are not masked by the one-cycle-per-incident constraint. */
    let freeIncidentId: string;
    let otherOrg: RegisteredUser;
    let otherIntegration: IntegrationDto & { token: string };
    beforeEach(async () => {
      await send(body([A()]));
      incidentId = (await app.testDb.query<{ id: string }>("SELECT id FROM incidents"))[0]!.id;
      freeIncidentId = (await app.database.tx((tx) => app.incidents.createFromAlert(tx, { organizationId: owner.auth.organizationId as string, title: "free", description: "", severity: "sev3", actor: { userId: null, displayName: "x" }, eventPayload: {} }))).id;
      otherOrg = await app.register("db-other@example.com", "Org B");
      otherIntegration = await app.integrations.create(otherOrg.auth, { name: "other" });
    });

    const insertCycle = (org: unknown, integrationId: string, fp: string, startsAt: string, incident: string, extra = ""): [string, unknown[]] => [
      `INSERT INTO alert_cycles (organization_id, integration_id, fingerprint, starts_at, incident_id${extra ? ", " + extra.split("=")[0] : ""}) VALUES ($1, $2, $3, $4::timestamptz, $5${extra ? ", " + extra.split("=")[1] : ""})`,
      [org, integrationId, fp, startsAt, incident],
    ];

    it("the unique constraint makes a second cycle for (integration, fingerprint, startsAt) impossible, even for a direct insert", async () => {
      const [c] = await app.testDb.query<{ fingerprint: string; starts_at: Date }>("SELECT fingerprint, starts_at FROM alert_cycles");
      const second = (await app.testDb.query<{ id: string }>("SELECT id FROM incidents"))[0]!.id;
      assert.equal(await sqlState([insertCycle(owner.auth.organizationId, integration.id, c!.fingerprint, c!.starts_at.toISOString(), second)]), "23505");
    });

    it("concurrent raw inserts of one cycle: exactly one wins (the database is the guarantee, not the application)", async () => {
      const mk = async () => {
        const created = await app.database.tx(async (tx) => app.incidents.createFromAlert(tx, { organizationId: owner.auth.organizationId as string, title: "t", description: "", severity: "sev3", actor: { userId: null, displayName: "x" }, eventPayload: {} }));
        return created.id;
      };
      const [i1, i2] = [await mk(), await mk()];
      const attempt = (incident: string) => app.database.tx(async (tx) => {
        const r = await tx.query("INSERT INTO alert_cycles (organization_id, integration_id, fingerprint, starts_at, incident_id) VALUES ($1, $2, 'race', '2026-01-01T00:00:00Z', $3) ON CONFLICT (integration_id, fingerprint, starts_at) DO NOTHING RETURNING id", [owner.auth.organizationId, integration.id, incident]);
        await new Promise((res) => setTimeout(res, 100));
        return r.rows.length;
      });
      const winners = await Promise.all([attempt(i1), attempt(i2)]);
      assert.equal(winners.reduce((a, b) => a + b, 0), 1);
      assert.equal(await count("alert_cycles", "fingerprint = 'race'"), 1);
    });

    it("tenant-consistent foreign keys: a cycle cannot join an integration of one organization to an incident of another", async () => {
      assert.equal(await sqlState([insertCycle(otherOrg.auth.organizationId, otherIntegration.id, "x1", "2026-01-01T00:00:00Z", freeIncidentId)]), "23503", "the incident belongs to org A, the cycle claims org B");
      assert.equal(await sqlState([insertCycle(owner.auth.organizationId, otherIntegration.id, "x2", "2026-01-01T00:00:00Z", freeIncidentId)]), "23503", "integration belongs to org B");
      assert.equal(await sqlState([insertCycle(otherOrg.auth.organizationId, integration.id, "x3", "2026-01-01T00:00:00Z", freeIncidentId)]), "23503");
    });

    it("one incident can belong to at most one cycle", async () => {
      assert.equal(await sqlState([insertCycle(owner.auth.organizationId, integration.id, "second-fp", "2026-01-01T00:00:00Z", incidentId)]), "23505");
    });

    it("checks: token hash format and uniqueness, fingerprint format, delivery count, resolved consistency, names", async () => {
      const ins = (hash: string, name = "n") => ["INSERT INTO integrations (organization_id, name, token_hash) VALUES ($1, $2, $3)", [owner.auth.organizationId, name, hash]] as [string, unknown[]];
      assert.equal(await sqlState([ins("not-a-hash")]), "23514");
      assert.equal(await sqlState([ins(sha256(integration.token), "dup-hash")]), "23505");
      assert.equal(await sqlState([ins(sha256("fresh"), " padded ")]), "23514");
      assert.equal(await sqlState([ins(sha256("fresh2"), "")]), "23514");
      assert.equal(await sqlState([ins(sha256("fresh3"), "ok-name")]), "ok");
      assert.equal(await sqlState([insertCycle(owner.auth.organizationId, integration.id, "bad fp", "2026-01-01T00:00:00Z", incidentId)]), "23514");
      assert.equal(await sqlState([["UPDATE alert_cycles SET delivery_count = 0", []]]), "23514");
      assert.equal(await sqlState([["UPDATE alert_cycles SET state = 'resolved'", []]]), "23514", "resolved needs resolved_at");
      assert.equal(await sqlState([["UPDATE alert_cycles SET resolved_at = now()", []]]), "23514", "firing cannot have resolved_at");
      assert.equal(await sqlState([["UPDATE alert_cycles SET state = 'bogus'", []]]), "23514");
    });

    it("the timeline stays append-only for entries written by ingestion, and incident status transitions stay guarded", async () => {
      assert.equal(await sqlState([["UPDATE incident_events SET payload = '{}'::jsonb", []]]), "42501");
      assert.equal(await sqlState([["DELETE FROM incident_events", []]]), "42501");
      assert.equal(await sqlState([["UPDATE incidents SET status = 'mitigated' WHERE id = $1", [incidentId]]]), "23514", "triggered -> mitigated is not a legal transition");
    });

    it("deleting an organization cascades to its integrations and cycles", async () => {
      assert.equal(await sqlState([["DELETE FROM organizations WHERE id = $1", [owner.auth.organizationId]]]), "ok");
    });
  });
});
