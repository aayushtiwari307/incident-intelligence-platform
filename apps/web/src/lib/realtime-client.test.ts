import assert from "node:assert/strict";
import { REALTIME_EVENTS } from "@platform/shared";
import { isIncidentMessage, startRealtime, type RealtimeHandlers, type RealtimeStatus, type SocketLike } from "./realtime-client";

class FakeSocket implements SocketLike {
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();
  connects = 0;
  closed = false;
  on(event: string, listener: (payload: unknown) => void): void {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
  }
  connect(): void {
    this.connects += 1;
  }
  close(): void {
    this.closed = true;
  }
  fire(event: string, payload?: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

const message = {
  eventId: 1,
  incidentId: "i",
  event: { id: 1, type: "comment", actor: { id: null, label: "a" }, payload: {}, createdAt: "t" },
  incident: { id: "i", version: 2 },
};

function rig() {
  const socket = new FakeSocket();
  const statuses: RealtimeStatus[] = [];
  const events: unknown[] = [];
  const syncs: string[] = [];
  let lost = 0;
  const handlers: RealtimeHandlers = {
    onStatus: (s) => void statuses.push(s),
    onEvent: (m) => void events.push(m),
    onSync: (r) => void syncs.push(r),
    onAccessLost: () => void (lost += 1),
  };
  const connection = startRealtime({ createSocket: () => socket, handlers, retryDelaysMs: [5, 10] });
  return { socket, statuses, events, syncs, lost: () => lost, connection };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("startRealtime", () => {
  it("is live and asks for a REST reload only once the server says it is subscribed", () => {
    const r = rig();
    r.socket.fire("connect");
    assert.deepEqual(r.syncs, [], "connected is not yet subscribed");
    r.socket.fire(REALTIME_EVENTS.ready, { organizationId: "o" });
    assert.deepEqual(r.syncs, ["ready"]);
    assert.equal(r.statuses.at(-1), "live");
  });

  it("reloads again after every reconnect (a reconnect is a fresh subscription)", () => {
    const r = rig();
    r.socket.fire(REALTIME_EVENTS.ready);
    r.socket.fire("disconnect", "transport close");
    assert.equal(r.statuses.at(-1), "reconnecting");
    r.socket.fire("connect");
    r.socket.fire(REALTIME_EVENTS.ready);
    assert.deepEqual(r.syncs, ["ready", "ready"]);
    assert.equal(r.statuses.at(-1), "live");
    assert.equal(r.lost(), 0);
  });

  it("passes well-formed incident messages on and drops malformed ones", () => {
    const r = rig();
    r.socket.fire(REALTIME_EVENTS.incident, message);
    r.socket.fire(REALTIME_EVENTS.incident, { eventId: "1" });
    r.socket.fire(REALTIME_EVENTS.incident, null);
    r.socket.fire(REALTIME_EVENTS.incident, { ...message, incident: null });
    assert.equal(r.events.length, 1);
  });

  it("maps a server resync request to a reload, defaulting an unknown reason safely", () => {
    const r = rig();
    r.socket.fire(REALTIME_EVENTS.resync, { reason: "overflow" });
    r.socket.fire(REALTIME_EVENTS.resync, { reason: "something-new" });
    r.socket.fire(REALTIME_EVENTS.resync, undefined);
    assert.deepEqual(r.syncs, ["overflow", "stream_gap", "stream_gap"]);
  });

  it("treats a server-initiated disconnect as lost access, not as a transient failure", () => {
    const r = rig();
    r.socket.fire(REALTIME_EVENTS.ready);
    r.socket.fire("disconnect", "io server disconnect");
    assert.equal(r.statuses.at(-1), "offline");
    assert.equal(r.lost(), 1);
  });

  it.each(["UNAUTHENTICATED", "NO_ORGANIZATION", "FORBIDDEN"])("stops and asks to refresh the session on a %s refusal", (code) => {
    const r = rig();
    r.socket.fire("connect_error", { message: code, data: { code } });
    assert.equal(r.socket.closed, true);
    assert.equal(r.lost(), 1);
    assert.equal(r.statuses.at(-1), "offline");
  });

  it("retries a transient refusal itself, with the configured delays", async () => {
    const r = rig();
    r.socket.fire("connect_error", { message: "UNAVAILABLE", data: { code: "UNAVAILABLE" } });
    assert.equal(r.statuses.at(-1), "reconnecting");
    assert.equal(r.lost(), 0);
    await sleep(40);
    assert.equal(r.socket.connects, 1);
    r.socket.fire("connect_error", { message: "TOO_MANY_CONNECTIONS", data: { code: "TOO_MANY_CONNECTIONS" } });
    await sleep(60);
    assert.equal(r.socket.connects, 2);
    assert.equal(r.socket.closed, false);
  });

  it("leaves lower-level failures (no refusal code) to Socket.IO's own retry", async () => {
    const r = rig();
    r.socket.fire("connect_error", new Error("websocket error"));
    assert.equal(r.statuses.at(-1), "reconnecting");
    await sleep(40);
    assert.equal(r.socket.connects, 0);
    assert.equal(r.lost(), 0);
  });

  it("ignores everything after stop(), including a pending manual retry", async () => {
    const r = rig();
    r.socket.fire("connect_error", { data: { code: "UNAVAILABLE" } });
    r.connection.stop();
    assert.equal(r.socket.closed, true);
    r.socket.fire(REALTIME_EVENTS.ready);
    r.socket.fire(REALTIME_EVENTS.incident, message);
    r.socket.fire("disconnect", "io server disconnect");
    await sleep(40);
    assert.equal(r.socket.connects, 0);
    assert.deepEqual(r.syncs, []);
    assert.deepEqual(r.events, []);
    assert.equal(r.lost(), 0);
  });
});

describe("isIncidentMessage", () => {
  it("accepts the documented shape only", () => {
    assert.equal(isIncidentMessage(message), true);
    assert.equal(isIncidentMessage({ ...message, eventId: undefined }), false);
    assert.equal(isIncidentMessage({ ...message, event: { id: "1", type: "x" } }), false);
    assert.equal(isIncidentMessage("x"), false);
  });
});
