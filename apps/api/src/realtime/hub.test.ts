import assert from "node:assert/strict";
import { REALTIME_EVENTS } from "@platform/shared";
import { RealtimeHub } from "./hub";
import { organizationRoom } from "./notification";
import { FakeAuth, FakeEvents, FakeSocket, FakeTransport, ORG_A, ORG_B, deferred, flush, notification } from "../test-support/realtime-doubles";
import type { SocketBinding } from "./types";

interface Rig {
  auth: FakeAuth;
  events: FakeEvents;
  transport: FakeTransport;
  hub: RealtimeHub;
  warnings: string[];
}

function rig(options: { secureCookies?: boolean; maxConnectionsPerUser?: number; maxPendingNotifications?: number; maxConsecutiveSweepFailures?: number } = {}): Rig {
  const auth = new FakeAuth();
  const events = new FakeEvents();
  const transport = new FakeTransport();
  const warnings: string[] = [];
  const hub = new RealtimeHub(auth, events, { secureCookies: false, ...options, log: { warn: (m) => void warnings.push(m) } });
  hub.bindTransport(transport);
  return { auth, events, transport, hub, warnings };
}

const binding = (sessionId: string, userId: string, organizationId: string): SocketBinding => ({ sessionId, userId, organizationId });

async function connect(r: Rig, id: string, b: SocketBinding): Promise<FakeSocket> {
  const socket = new FakeSocket(id, b);
  r.auth.sessions.set(b.sessionId, { ...b, role: "viewer" });
  await r.hub.onConnection(socket);
  return socket;
}

describe("RealtimeHub handshake", () => {
  it("accepts a valid session cookie and binds the connection to the session's organization", async () => {
    const r = rig();
    r.auth.addSession("tok", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: "viewer" });
    const result = await r.hub.authenticateHandshake({ cookie: "other=1; sid=tok" });
    assert.deepEqual(result, { ok: true, binding: { sessionId: "s1", userId: "u1", organizationId: ORG_A } });
  });

  it("rejects a missing cookie, an unknown token and a cookie with the wrong name", async () => {
    const r = rig();
    r.auth.addSession("tok", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: "viewer" });
    for (const headers of [{}, { cookie: "sid=nope" }, { cookie: "session=tok" }, { cookie: "__Host-sid=tok" }]) {
      assert.deepEqual(await r.hub.authenticateHandshake(headers), { ok: false, code: "UNAUTHENTICATED" });
    }
  });

  it("uses the __Host- cookie name in production mode and ignores the development name", async () => {
    const r = rig({ secureCookies: true });
    r.auth.addSession("tok", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: "viewer" });
    assert.equal((await r.hub.authenticateHandshake({ cookie: "__Host-sid=tok" })).ok, true);
    assert.deepEqual(await r.hub.authenticateHandshake({ cookie: "sid=tok" }), { ok: false, code: "UNAUTHENTICATED" });
  });

  it("rejects a session without an active organization", async () => {
    const r = rig();
    r.auth.addSession("tok", { sessionId: "s1", userId: "u1", organizationId: null, role: null });
    assert.deepEqual(await r.hub.authenticateHandshake({ cookie: "sid=tok" }), { ok: false, code: "NO_ORGANIZATION" });
  });

  it("rejects a session whose membership is gone (organization set, role null)", async () => {
    const r = rig();
    r.auth.addSession("tok", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: null });
    assert.deepEqual(await r.hub.authenticateHandshake({ cookie: "sid=tok" }), { ok: false, code: "FORBIDDEN" });
  });

  it("reports UNAVAILABLE (not a crash, not an accept) when authentication itself fails", async () => {
    const r = rig();
    r.auth.failAuthenticate = new Error("db down");
    assert.deepEqual(await r.hub.authenticateHandshake({ cookie: "sid=tok" }), { ok: false, code: "UNAVAILABLE" });
    assert.equal(r.warnings.length, 1);
  });

  it("refuses new handshakes once closed", async () => {
    const r = rig();
    r.auth.addSession("tok", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: "viewer" });
    r.hub.close();
    assert.deepEqual(await r.hub.authenticateHandshake({ cookie: "sid=tok" }), { ok: false, code: "UNAVAILABLE" });
  });
});

describe("RealtimeHub connections", () => {
  it("joins exactly one room, the session's organization, and announces readiness", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    assert.deepEqual(socket.rooms, [organizationRoom(ORG_A)]);
    assert.deepEqual(socket.emitted, [{ event: REALTIME_EVENTS.ready, payload: { organizationId: ORG_A } }]);
    assert.deepEqual(r.hub.stats(), { connections: 1, organizations: 1, pending: 0 });
  });

  it("caps concurrent connections per user and frees the slot on disconnect", async () => {
    const r = rig({ maxConnectionsPerUser: 2 });
    r.auth.addSession("tok", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: "viewer" });
    await connect(r, "k1", binding("s1", "u1", ORG_A));
    await connect(r, "k2", binding("s1", "u1", ORG_A));
    assert.deepEqual(await r.hub.authenticateHandshake({ cookie: "sid=tok" }), { ok: false, code: "TOO_MANY_CONNECTIONS" });

    // Several handshakes can pass the check at once; the cap is enforced again when the connection arrives.
    const third = await connect(r, "k3", binding("s1", "u1", ORG_A));
    assert.equal(third.disconnected, true);
    assert.deepEqual(third.rooms, []);

    r.hub.onDisconnect("k1");
    assert.equal((await r.hub.authenticateHandshake({ cookie: "sid=tok" })).ok, true);
  });

  it("does not count other users against a user's cap", async () => {
    const r = rig({ maxConnectionsPerUser: 1 });
    await connect(r, "k1", binding("s1", "u1", ORG_A));
    const other = await connect(r, "k2", binding("s2", "u2", ORG_A));
    assert.equal(other.disconnected, false);
  });

  it("disconnects a connection whose room join fails and does not keep it", async () => {
    const r = rig();
    const socket = new FakeSocket("k1", binding("s1", "u1", ORG_A));
    socket.joinError = new Error("adapter down");
    await r.hub.onConnection(socket);
    assert.equal(socket.disconnected, true);
    assert.equal(r.hub.stats().connections, 0);
    assert.deepEqual(socket.emitted, []);
  });

  it("refuses connections once closed", async () => {
    const r = rig();
    r.hub.close();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    assert.equal(socket.disconnected, true);
  });
});

describe("RealtimeHub delivery", () => {
  it("broadcasts a committed event only to the room of the organization it belongs to", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    await connect(r, "b1", binding("sb", "ub", ORG_B));

    r.hub.handleNotification(notification(7, ORG_A));
    await flush();

    assert.equal(r.transport.sent.length, 1);
    const sent = r.transport.sent[0];
    assert.equal(sent?.room, organizationRoom(ORG_A));
    assert.equal(sent?.event, REALTIME_EVENTS.incident);
    assert.equal((sent?.payload as { eventId: number }).eventId, 7);
    assert.deepEqual(r.events.loads, [{ organizationId: ORG_A, eventId: 7 }]);
    assert.ok(r.transport.sent.every((m) => m.room !== organizationRoom(ORG_B)));
  });

  it("does not even load events for organizations nobody on this instance belongs to", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    r.hub.handleNotification(notification(1, ORG_B));
    await flush();
    assert.deepEqual(r.events.loads, []);
    assert.deepEqual(r.transport.sent, []);
  });

  it("stops loading for an organization once its last connection leaves", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    r.hub.onDisconnect("a1");
    r.hub.handleNotification(notification(1, ORG_A));
    await flush();
    assert.deepEqual(r.events.loads, []);
  });

  it("keeps commit order even when an earlier event loads more slowly than a later one", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    const gate = deferred();
    r.events.gates.set(1, gate.promise);

    r.hub.handleNotification(notification(1, ORG_A));
    r.hub.handleNotification(notification(2, ORG_A));
    r.hub.handleNotification(notification(3, ORG_A));
    await flush();
    assert.equal(r.transport.sent.length, 0, "nothing may overtake the slow first event");

    gate.resolve();
    await flush();
    assert.deepEqual(
      r.transport.sent.map((m) => (m.payload as { eventId: number }).eventId),
      [1, 2, 3],
    );
  });

  it("asks that organization to resync, and carries on, when one event cannot be loaded", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    await connect(r, "b1", binding("sb", "ub", ORG_B));
    r.events.failures.add(1);

    r.hub.handleNotification(notification(1, ORG_A));
    r.hub.handleNotification(notification(2, ORG_A));
    await flush();

    assert.deepEqual(r.transport.sent[0], { room: organizationRoom(ORG_A), event: REALTIME_EVENTS.resync, payload: { reason: "load_failed" } });
    assert.equal((r.transport.sent[1]?.payload as { eventId: number }).eventId, 2);
    assert.equal(r.transport.sent.length, 2, "the other organization is not disturbed");
  });

  it("treats a missing event as a resync, not as silence", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    r.events.missing.add(5);
    r.hub.handleNotification(notification(5, ORG_A));
    await flush();
    assert.deepEqual(r.transport.sent, [{ room: organizationRoom(ORG_A), event: REALTIME_EVENTS.resync, payload: { reason: "load_failed" } }]);
  });

  it("asks everyone to resync on a malformed notification instead of guessing", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    await connect(r, "b1", binding("sb", "ub", ORG_B));
    r.hub.handleNotification("not json");
    await flush();
    assert.deepEqual(
      r.transport.sent.map((m) => [m.room, m.event]).sort(),
      [
        [organizationRoom(ORG_A), REALTIME_EVENTS.resync],
        [organizationRoom(ORG_B), REALTIME_EVENTS.resync],
      ].sort(),
    );
    assert.deepEqual(r.events.loads, []);
  });

  it("drops the backlog and asks for a resync when it grows past its bound", async () => {
    const r = rig({ maxPendingNotifications: 3 });
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    const gate = deferred();
    r.events.gates.set(1, gate.promise);
    // 1 is in flight (shifted off the queue); 2, 3, 4 fill the queue; 5 overflows.
    for (const id of [1, 2, 3, 4, 5]) r.hub.handleNotification(notification(id, ORG_A));
    await flush();
    assert.deepEqual(r.transport.sent.map((m) => m.event), [REALTIME_EVENTS.resync]);
    assert.deepEqual((r.transport.sent[0]?.payload as { reason: string }).reason, "overflow");
    gate.resolve();
    await flush();
    // The in-flight event still goes out; the dropped ones are covered by the resync.
    assert.deepEqual(r.transport.sent.map((m) => m.event), [REALTIME_EVENTS.resync, REALTIME_EVENTS.incident]);
  });

  it("tells connected organizations to resync after the notification stream was interrupted", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    r.hub.handleStreamGap();
    assert.deepEqual(r.transport.sent, [{ room: organizationRoom(ORG_A), event: REALTIME_EVENTS.resync, payload: { reason: "stream_gap" } }]);
  });

  it("ignores notifications after close", async () => {
    const r = rig();
    await connect(r, "a1", binding("sa", "ua", ORG_A));
    r.hub.close();
    r.hub.handleNotification(notification(1, ORG_A));
    await flush();
    assert.deepEqual(r.events.loads, []);
    assert.equal(r.transport.allDisconnected, true);
  });
});

describe("RealtimeHub access re-checks", () => {
  it("keeps connections whose session, user, organization and role are unchanged", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    assert.equal(await r.hub.revalidate(), 0);
    assert.equal(socket.disconnected, false);
  });

  it("keeps a connection when the member's role changes but still allows reading", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.sessions.set("s1", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: "admin" });
    assert.equal(await r.hub.revalidate(), 0);
    assert.equal(socket.disconnected, false);
  });

  it("disconnects a revoked or expired session (absent from the live set)", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.sessions.delete("s1");
    assert.equal(await r.hub.revalidate(), 1);
    assert.equal(socket.disconnected, true);
    assert.equal(r.hub.stats().connections, 0);
  });

  it("disconnects a removed member (organization still set, role gone)", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.sessions.set("s1", { sessionId: "s1", userId: "u1", organizationId: ORG_A, role: null });
    await r.hub.revalidate();
    assert.equal(socket.disconnected, true);
  });

  it("disconnects a connection whose session switched to another organization", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.sessions.set("s1", { sessionId: "s1", userId: "u1", organizationId: ORG_B, role: "owner" });
    await r.hub.revalidate();
    assert.equal(socket.disconnected, true);
  });

  it("disconnects a connection whose session lost its active organization", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.sessions.set("s1", { sessionId: "s1", userId: "u1", organizationId: null, role: null });
    await r.hub.revalidate();
    assert.equal(socket.disconnected, true);
  });

  it("disconnects only the affected connections", async () => {
    const r = rig();
    const keep = await connect(r, "k1", binding("s1", "u1", ORG_A));
    const drop = await connect(r, "k2", binding("s2", "u2", ORG_A));
    const dropToo = await connect(r, "k3", binding("s2", "u2", ORG_A));
    r.auth.sessions.delete("s2");
    assert.equal(await r.hub.revalidate(), 2);
    assert.equal(keep.disconnected, false);
    assert.equal(drop.disconnected && dropToo.disconnected, true);
  });

  it("asks the database about each session once, however many tabs it has open", async () => {
    const r = rig();
    await connect(r, "k1", binding("s1", "u1", ORG_A));
    await connect(r, "k2", binding("s1", "u1", ORG_A));
    await r.hub.revalidate();
    assert.equal(r.auth.resolveCalls, 1);
  });

  it("does not judge a connection that arrived while the check was running by that check's older answer", async () => {
    const r = rig();
    await connect(r, "k1", binding("s1", "u1", ORG_A));
    const gate = deferred();
    r.auth.resolveGate = gate.promise;
    const sweep = r.hub.revalidate();
    await flush();
    const late = await connect(r, "k2", binding("s9", "u9", ORG_A));
    r.auth.sessions.delete("s9"); // the stale answer would not include s9
    gate.resolve();
    await sweep;
    assert.equal(late.disconnected, false);
  });

  it("serialises overlapping checks", async () => {
    const r = rig();
    await connect(r, "k1", binding("s1", "u1", ORG_A));
    const gate = deferred();
    r.auth.resolveGate = gate.promise;
    const first = r.hub.revalidate();
    const second = r.hub.revalidate();
    await flush();
    assert.equal(r.auth.resolveCalls, 1, "the second check waits for the first");
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(r.auth.resolveCalls, 2);
  });

  it("tolerates a failing check but fails closed after repeated failures", async () => {
    const r = rig({ maxConsecutiveSweepFailures: 3 });
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.failResolve = new Error("db down");
    assert.equal(await r.hub.revalidate(), 0);
    assert.equal(await r.hub.revalidate(), 0);
    assert.equal(socket.disconnected, false);
    assert.equal(await r.hub.revalidate(), 1);
    assert.equal(socket.disconnected, true);
  });

  it("resets the failure count after a successful check", async () => {
    const r = rig({ maxConsecutiveSweepFailures: 2 });
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.failResolve = new Error("db down");
    await r.hub.revalidate();
    r.auth.failResolve = null;
    await r.hub.revalidate();
    r.auth.failResolve = new Error("db down");
    await r.hub.revalidate();
    assert.equal(socket.disconnected, false);
  });

  it("requestRevalidation runs a check without the caller waiting", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.auth.sessions.delete("s1");
    r.hub.requestRevalidation();
    await flush();
    assert.equal(socket.disconnected, true);
  });

  it("runs checks on a timer once started and stops them on close", async () => {
    const r = rig();
    const socket = await connect(r, "k1", binding("s1", "u1", ORG_A));
    r.hub.startSweeper(10);
    r.auth.sessions.delete("s1");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(socket.disconnected, true);
    const calls = r.auth.resolveCalls;
    r.hub.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(r.auth.resolveCalls, calls);
  });
});
