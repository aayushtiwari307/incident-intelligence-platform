import "reflect-metadata";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { REALTIME_EVENTS, REALTIME_PATH, type IncidentRealtimeMessage, type ResyncMessage } from "@platform/shared";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { io, type Socket } from "socket.io-client";
import { AppModule } from "../app.module";
import { loadConfig } from "../config/env";
import { runMigrations } from "../db/migrate/runner";
import { configureHttpApplication } from "../http/configure-http";
import { createTestDatabase, type TestDatabase } from "../test-support/session-factory";

const ORIGIN = "http://127.0.0.1:3000";
const PASSWORD = "a-valid-realtime-password-123";

interface Client {
  socket: Socket;
  events: IncidentRealtimeMessage[];
  resyncs: ResyncMessage[];
  disconnects: string[];
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(description: string, predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${description}`);
    await sleep(25);
  }
}

/**
 * Real Nest application + real PostgreSQL + real Socket.IO server and client over a real WebSocket. Nothing about
 * delivery, authentication or the LISTEN/NOTIFY trigger is replaced.
 */
describe("real-time updates (Nest + PostgreSQL LISTEN/NOTIFY + Socket.IO)", () => {
  let testDb: TestDatabase;
  let app: NestExpressApplication;
  let baseUrl = "";
  const clients: Client[] = [];

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await runMigrations(testDb.connect, { mode: "apply", directory: path.resolve(__dirname, "../../migrations") });
    const config = loadConfig({
      NODE_ENV: "test",
      API_HOST: "127.0.0.1",
      API_PORT: "3001",
      DATABASE_URL: testDb.connectionString,
      REDIS_URL: "redis://127.0.0.1:6380",
      CORS_ORIGINS: ORIGIN,
      TRUST_PROXY_HOPS: "0",
      MIGRATE_ON_START: "off",
      LOG_LEVEL: "error",
      AI_PROVIDER: "none",
      REALTIME_REVALIDATE_SECONDS: "1",
    });
    const testingModule = await Test.createTestingModule({ imports: [AppModule.forRoot(config)] }).compile();
    app = testingModule.createNestApplication<NestExpressApplication>({ bodyParser: false });
    configureHttpApplication(app, config);
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address() as AddressInfo | null;
    assert.ok(address && typeof address === "object");
    baseUrl = `http://127.0.0.1:${address.port}`;
  }, 30_000);

  afterEach(() => {
    for (const client of clients.splice(0)) client.socket.close();
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      await testDb?.drop();
    }
  }, 30_000);

  // ---- helpers ------------------------------------------------------------------------------------------------

  async function http(pathname: string, options: { method?: string; cookie?: string; body?: unknown } = {}) {
    const headers: Record<string, string> = { Origin: ORIGIN };
    if (options.cookie) headers.Cookie = options.cookie;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
    const text = response.status === 204 ? "" : await response.text();
    return { response, body: (text ? JSON.parse(text) : undefined) as Record<string, any> | undefined }; // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped JSON asserted field by field
  }

  async function register(email: string, organizationName: string) {
    const { response, body } = await http("/api/auth/register", {
      method: "POST",
      body: { email, password: PASSWORD, displayName: email.split("@")[0], organizationName },
    });
    assert.equal(response.status, 201, JSON.stringify(body));
    const cookie = (response.headers.get("set-cookie") as string).split(";")[0] as string;
    return { cookie, userId: body?.user.id as string, organizationId: body?.activeOrganizationId as string };
  }

  /** Registers a user and makes them a member of `owner`'s organization through the real invitation flow. */
  async function addMember(owner: { cookie: string }, email: string, role: "viewer" | "responder" | "admin") {
    const invite = await http("/api/organization/invites", { method: "POST", cookie: owner.cookie, body: { email, role } });
    assert.equal(invite.response.status, 201, JSON.stringify(invite.body));
    const member = await register(email, `${email} personal org`);
    const accepted = await http("/api/organization/invites/accept", { method: "POST", cookie: member.cookie, body: { token: invite.body?.token } });
    assert.equal(accepted.response.status, 200, JSON.stringify(accepted.body));
    return member;
  }

  const createIncident = async (cookie: string, title: string) => {
    const { response, body } = await http("/api/incidents", { method: "POST", cookie, body: { title, description: "", severity: "sev3" } });
    assert.equal(response.status, 201, JSON.stringify(body));
    return body as { id: string; version: number };
  };

  function open(cookie: string | undefined, origin: string | undefined = ORIGIN): { client: Client; ready: Promise<void>; rejected: Promise<{ message: string; code?: string }> } {
    const socket = io(baseUrl, {
      path: REALTIME_PATH,
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      extraHeaders: { ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) },
    });
    const client: Client = { socket, events: [], resyncs: [], disconnects: [] };
    clients.push(client);
    socket.on(REALTIME_EVENTS.incident, (message: IncidentRealtimeMessage) => client.events.push(message));
    socket.on(REALTIME_EVENTS.resync, (message: ResyncMessage) => client.resyncs.push(message));
    socket.on("disconnect", (reason: string) => client.disconnects.push(reason));
    const ready = new Promise<void>((resolve) => socket.once(REALTIME_EVENTS.ready, () => resolve()));
    const rejected = new Promise<{ message: string; code?: string }>((resolve) =>
      socket.once("connect_error", (error: Error & { data?: { code?: string } }) => resolve({ message: error.message, code: error.data?.code })),
    );
    return { client, ready, rejected };
  }

  async function connect(cookie: string): Promise<Client> {
    const { client, ready, rejected } = open(cookie);
    const outcome = await Promise.race([ready.then(() => "ready" as const), rejected.then((r) => r)]);
    assert.equal(outcome, "ready", `connection was refused: ${JSON.stringify(outcome)}`);
    return client;
  }

  const eventTypes = (client: Client): string[] => client.events.map((m) => m.event.type);

  // ---- authentication and origin ------------------------------------------------------------------------------

  it("refuses a connection without a session cookie", async () => {
    const { rejected } = open(undefined);
    assert.deepEqual(await rejected, { message: "UNAUTHENTICATED", code: "UNAUTHENTICATED" });
  });

  it("refuses a connection with an invalid session token", async () => {
    const { rejected } = open("sid=not-a-real-token");
    assert.equal((await rejected).code, "UNAUTHENTICATED");
  });

  it("refuses a connection from a foreign Origin even with a valid session cookie", async () => {
    const owner = await register("origin-owner@example.com", "Origin Org");
    const { client, ready, rejected } = open(owner.cookie, "https://evil.example");
    const outcome = await Promise.race([ready.then(() => "ready" as const), rejected.then(() => "rejected" as const)]);
    assert.equal(outcome, "rejected");
    assert.equal(client.socket.connected, false);
  });

  it("refuses a user who has no active organization (invited user whose only membership was removed)", async () => {
    const owner = await register("no-org-owner@example.com", "No Org Org");
    const invite = await http("/api/organization/invites", { method: "POST", cookie: owner.cookie, body: { email: "no-org-user@example.com", role: "viewer" } });
    assert.equal(invite.response.status, 201, JSON.stringify(invite.body));
    // Registering WITH an invitation creates no personal organization, so this user's only membership is the invited one.
    const joined = await http("/api/auth/register-with-invite", {
      method: "POST",
      body: { email: "no-org-user@example.com", password: PASSWORD, displayName: "No Org User", inviteToken: invite.body?.token },
    });
    assert.equal(joined.response.status, 201, JSON.stringify(joined.body));
    const cookie = (joined.response.headers.get("set-cookie") as string).split(";")[0] as string;

    const removed = await http(`/api/organization/members/${joined.body?.user.id}`, { method: "DELETE", cookie: owner.cookie });
    assert.equal(removed.response.status, 204);

    const { rejected } = open(cookie);
    assert.equal((await rejected).code, "NO_ORGANIZATION");
  });

  // ---- delivery -----------------------------------------------------------------------------------------------

  it("pushes created, transition and comment events to the organization in commit order, with state snapshots", async () => {
    const owner = await register("delivery-owner@example.com", "Delivery Org");
    const live = await connect(owner.cookie);

    const incident = await createIncident(owner.cookie, "Checkout latency elevated");
    await waitFor("created event", () => eventTypes(live).includes("created"));
    const created = live.events.find((m) => m.event.type === "created") as IncidentRealtimeMessage;
    assert.equal(created.incidentId, incident.id);
    assert.equal(created.incident.title, "Checkout latency elevated");
    assert.equal(created.incident.version, 1);

    const transition = await http(`/api/incidents/${incident.id}/transitions`, { method: "POST", cookie: owner.cookie, body: { to: "acknowledged", expectedVersion: 1 } });
    assert.equal(transition.response.status, 200);
    const comment = await http(`/api/incidents/${incident.id}/comments`, { method: "POST", cookie: owner.cookie, body: { body: "Looking now" } });
    assert.equal(comment.response.status, 201);

    await waitFor("status_changed and comment events", () => eventTypes(live).includes("status_changed") && eventTypes(live).includes("comment"));
    const ids = live.events.map((m) => m.eventId);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "events arrive in commit order");
    assert.equal(new Set(ids).size, ids.length, "no duplicates");

    const statusMessage = live.events.find((m) => m.event.type === "status_changed") as IncidentRealtimeMessage;
    assert.deepEqual(statusMessage.event.payload, { from: "triggered", to: "acknowledged" });
    assert.ok(statusMessage.incident.version >= 2);
    assert.equal(live.events.find((m) => m.event.type === "comment")?.event.payload.body, "Looking now");
  });

  it("delivers to every connected member of the organization, including a read-only viewer", async () => {
    const owner = await register("multi-owner@example.com", "Multi Org");
    const viewer = await addMember(owner, "multi-viewer@example.com", "viewer");
    const ownerLive = await connect(owner.cookie);
    const viewerLive = await connect(viewer.cookie);

    await createIncident(owner.cookie, "Shared incident");
    await waitFor("both members receive created", () => eventTypes(ownerLive).includes("created") && eventTypes(viewerLive).includes("created"));
  });

  it("never delivers one organization's events to another organization's connections", async () => {
    const orgA = await register("iso-a@example.com", "Isolation A");
    const orgB = await register("iso-b@example.com", "Isolation B");
    const liveA = await connect(orgA.cookie);
    const liveB = await connect(orgB.cookie);

    // A malicious client tries every way it can think of to subscribe to the other tenant. None has a server handler.
    liveA.socket.emit("join", `org:${orgB.organizationId}`);
    liveA.socket.emit("subscribe", { organizationId: orgB.organizationId });
    liveA.socket.emit("incident.subscribe", orgB.organizationId);

    const incidentB = await createIncident(orgB.cookie, "B's private incident");
    await waitFor("B receives its own event (positive control)", () => eventTypes(liveB).includes("created"));
    await http(`/api/incidents/${incidentB.id}/comments`, { method: "POST", cookie: orgB.cookie, body: { body: "B secret" } });
    await waitFor("B receives its comment", () => eventTypes(liveB).includes("comment"));
    await sleep(400); // give any leak time to show up

    assert.deepEqual(liveA.events, [], "organization A received nothing from organization B");
    assert.ok(liveB.events.every((m) => m.incidentId === incidentB.id));

    await createIncident(orgA.cookie, "A's own incident");
    await waitFor("A receives its own event", () => eventTypes(liveA).includes("created"));
    assert.ok(liveB.events.every((m) => m.incident.title !== "A's own incident"), "organization B received nothing from organization A");
  });

  it("emits nothing for a transaction that rolls back, and does emit once one commits", async () => {
    const owner = await register("tx-owner@example.com", "Transaction Org");
    const live = await connect(owner.cookie);
    const incident = await createIncident(owner.cookie, "Transactional");
    await waitFor("created event", () => eventTypes(live).includes("created"));
    const before = live.events.length;

    const insert = `INSERT INTO incident_events (organization_id, incident_id, type, actor_label, payload) VALUES ($1, $2, 'comment', 'sql', '{"body":"raw"}'::jsonb)`;
    const session = await testDb.connect();
    try {
      await session.query("BEGIN");
      await session.query(insert, [owner.organizationId, incident.id]);
      await session.query("ROLLBACK");
      await sleep(400);
      assert.equal(live.events.length, before, "a rolled-back timeline entry must never be pushed");

      await session.query("BEGIN");
      await session.query(insert, [owner.organizationId, incident.id]);
      await session.query("COMMIT");
    } finally {
      await session.close();
    }
    await waitFor("committed entry pushed", () => live.events.length === before + 1);
    assert.equal(live.events[before]?.event.payload.body, "raw");
  });

  // ---- ending access ------------------------------------------------------------------------------------------

  it("closes the connection immediately when its session logs out, and pushes nothing afterwards", async () => {
    const owner = await register("logout-owner@example.com", "Logout Org");
    const member = await addMember(owner, "logout-member@example.com", "responder");
    const live = await connect(member.cookie);

    const out = await http("/api/auth/logout", { method: "POST", cookie: member.cookie, body: {} });
    assert.equal(out.response.status, 204);
    await waitFor("server closes the connection", () => live.disconnects.length > 0, 4000);

    await createIncident(owner.cookie, "After logout");
    await sleep(300);
    assert.deepEqual(live.events, []);
  });

  it("closes a removed member's connection immediately", async () => {
    const owner = await register("remove-owner@example.com", "Removal Org");
    const member = await addMember(owner, "remove-member@example.com", "viewer");
    const ownerLive = await connect(owner.cookie);
    const memberLive = await connect(member.cookie);

    const removed = await http(`/api/organization/members/${member.userId}`, { method: "DELETE", cookie: owner.cookie });
    assert.equal(removed.response.status, 204);
    await waitFor("removed member is disconnected", () => memberLive.disconnects.length > 0, 4000);

    await createIncident(owner.cookie, "After removal");
    await waitFor("owner still receives", () => eventTypes(ownerLive).includes("created"));
    assert.deepEqual(memberLive.events, []);
  });

  it("closes a connection when its session switches to another organization; a new connection joins only the new one", async () => {
    const owner = await register("switch-owner@example.com", "Switch Org");
    const member = await addMember(owner, "switch-member@example.com", "responder");
    const first = await connect(member.cookie);

    // The member also owns a personal organization; switch the session to it.
    const me = await http("/api/auth/me", { cookie: member.cookie });
    const personal = (me.body?.memberships as Array<{ organizationId: string }>).find((m) => m.organizationId !== owner.organizationId);
    assert.ok(personal, "member has a personal organization");
    const switched = await http("/api/auth/switch-organization", { method: "POST", cookie: member.cookie, body: { organizationId: personal.organizationId } });
    assert.equal(switched.response.status, 200);
    await waitFor("old connection closed", () => first.disconnects.length > 0, 4000);

    const second = await connect(member.cookie);
    await createIncident(owner.cookie, "Event in the organization the member switched away from");
    await sleep(400);
    assert.deepEqual(second.events, [], "the new connection is bound to the personal organization only");
  });

  it("cuts off a session revoked behind the API's back within one periodic check", async () => {
    const owner = await register("sweep-owner@example.com", "Sweep Org");
    const live = await connect(owner.cookie);
    await testDb.query("UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1", [owner.userId]);
    await waitFor("periodic check disconnects the revoked session", () => live.disconnects.length > 0, 6000);
  });

  // ---- recovery -----------------------------------------------------------------------------------------------

  it("tells clients to resync after the notification connection drops, then keeps delivering", async () => {
    const owner = await register("gap-owner@example.com", "Gap Org");
    const live = await connect(owner.cookie);

    await testDb.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'LISTEN %' AND pid <> pg_backend_pid()",
    );
    await waitFor("stream_gap resync after reconnect", () => live.resyncs.some((r) => r.reason === "stream_gap"), 10_000);

    await createIncident(owner.cookie, "After the gap");
    await waitFor("event after reconnect", () => eventTypes(live).includes("created"));
  });

  it("accepts a fresh connection after a disconnect (reconnect is a new authenticated handshake)", async () => {
    const owner = await register("reconnect-owner@example.com", "Reconnect Org");
    const first = await connect(owner.cookie);
    first.socket.close();
    const second = await connect(owner.cookie);
    await createIncident(owner.cookie, "After reconnect");
    await waitFor("second connection receives", () => eventTypes(second).includes("created"));
    assert.deepEqual(first.events, []);
  });

  // ---- limits -------------------------------------------------------------------------------------------------

  it("limits concurrent connections per user", async () => {
    const owner = await register("cap-owner@example.com", "Cap Org");
    for (let i = 0; i < 10; i += 1) await connect(owner.cookie);
    const { rejected } = open(owner.cookie);
    assert.equal((await rejected).code, "TOO_MANY_CONNECTIONS");
  });
});
