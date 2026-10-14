import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseSetCookie, runSmoke, sessionCookieProblems } from "./smoke-stack.mjs";

describe("parseSetCookie / sessionCookieProblems", () => {
  it("parses name, value (which may contain '=') and attributes", () => {
    const c = parseSetCookie("__Host-sid=abc%3Ddef; Max-Age=3600; Path=/; HttpOnly; Secure; SameSite=Lax");
    assert.equal(c.name, "__Host-sid");
    assert.equal(c.value, "abc%3Ddef");
    assert.equal(c.attributes.path, "/");
    assert.equal(c.attributes.httponly, true);
    assert.equal(c.attributes.samesite, "Lax");
  });

  it("accepts the production cookie and the development cookie", () => {
    assert.deepEqual(sessionCookieProblems(parseSetCookie("__Host-sid=x; Path=/; HttpOnly; Secure; SameSite=Lax")), []);
    assert.deepEqual(sessionCookieProblems(parseSetCookie("sid=x; Path=/; HttpOnly; SameSite=Lax")), []);
  });

  it("flags every weakening of the cookie", () => {
    assert.match(sessionCookieProblems(parseSetCookie("sid=x; Path=/; SameSite=Lax")).join(), /HttpOnly/);
    assert.match(sessionCookieProblems(parseSetCookie("sid=x; Path=/; HttpOnly; SameSite=None")).join(), /SameSite=Lax/);
    assert.match(sessionCookieProblems(parseSetCookie("__Host-sid=x; Path=/; HttpOnly; SameSite=Lax")).join(), /Secure/);
    assert.match(sessionCookieProblems(parseSetCookie("__Host-sid=x; Path=/a; HttpOnly; Secure; SameSite=Lax")).join(), /Path=\//);
    assert.match(sessionCookieProblems(parseSetCookie("__Host-sid=x; Domain=example.com; Path=/; HttpOnly; Secure; SameSite=Lax")).join(), /Domain/);
  });
});

describe("runSmoke", () => {
  it("fails fast and reports which check failed when the API misbehaves", async () => {
    const logs = [];
    const brokenFetch = async () => new Response('{"status":"down"}', { status: 503 });
    await assert.rejects(runSmoke({ apiUrl: "http://api.invalid", webUrl: null, log: (m) => logs.push(m), fetchImpl: brokenFetch }), /status 503/);
    assert.ok(logs.some((line) => line.startsWith("FAIL API liveness")));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// WebSocket checks, driven against a FAKE Socket.IO server (EventEmitter based) so the check logic itself is tested:
// that it passes for a correct server, and (negative controls) fails, naming the check, for each way a server can be wrong.

import { EventEmitter } from "node:events";
import { createProbe, runRealtimeChecks } from "./smoke-stack.mjs";

const ORIGIN = "http://127.0.0.1:3000";

/** A tiny model of the real server: cookies map to organizations; pushes go to the incident's organization. */
function fakeWorld(faults = {}) {
  const orgOf = { cookieA: "orgA", cookieA2: "orgA", cookieB: "orgB" };
  const sockets = [];
  const revoked = new Set();
  let nextId = 1;
  const incidentOrg = new Map();
  const factory = (_url, options) => {
    const socket = new EventEmitter();
    socket.close = () => undefined;
    const cookie = options.extraHeaders.Cookie;
    const origin = options.extraHeaders.Origin;
    queueMicrotask(() => {
      if (faults.noRealtimeEndpoint) return void socket.emit("connect_error", new Error("websocket error"));
      if (origin !== ORIGIN && !faults.acceptAnyOrigin) return void socket.emit("connect_error", new Error("websocket error"));
      if ((!cookie || !orgOf[cookie]) && !faults.acceptAnonymous) return void socket.emit("connect_error", Object.assign(new Error("UNAUTHENTICATED"), { data: { code: "UNAUTHENTICATED" } }));
      socket.emit("connect");
      if (!faults.neverReady) {
        sockets.push({ socket, cookie, org: orgOf[cookie] ?? "orgA" });
        socket.emit("realtime.ready", { organizationId: orgOf[cookie] });
      }
    });
    return socket;
  };
  const push = (org, incidentId) => {
    for (const entry of sockets) {
      if (faults.leakAcrossOrganizations || entry.org === org) {
        if (faults.dropPushes) continue;
        entry.socket.emit("incident.event", { eventId: 1, incidentId, event: {}, incident: {} });
      }
    }
  };
  return {
    factory,
    ctx: {
      socketUrl: "http://api.test",
      origin: ORIGIN,
      cookie: "cookieA",
      socketFactory: factory,
      connectTimeoutMs: 60,
      pushTimeoutMs: 60,
      closeTimeoutMs: 60,
      createIncident: async (cookie) => {
        const id = `incident-${nextId++}`;
        incidentOrg.set(id, orgOf[cookie]);
        push(orgOf[cookie], id);
        return id;
      },
      registerOtherOrg: async () => "cookieB",
      loginSecondSession: async () => "cookieA2",
      logout: async (cookie) => {
        revoked.add(cookie);
        if (faults.neverClosesAfterLogout) return;
        for (const entry of sockets.filter((e) => e.cookie === cookie)) entry.socket.emit("disconnect", "io server disconnect");
      },
    },
  };
}

async function runChecks(faults) {
  const names = [];
  const world = fakeWorld(faults);
  const step = async (name, fn) => {
    try {
      await fn();
    } catch (error) {
      names.push(`FAIL ${name}`);
      throw error;
    }
    names.push(`ok ${name}`);
  };
  await runRealtimeChecks({ ...world.ctx, step });
  return names;
}

describe("runRealtimeChecks (fake server)", () => {
  it("passes against a correct server and runs all six checks", async () => {
    const names = await runChecks({});
    assert.equal(names.length, 6);
    assert.ok(names.every((n) => n.startsWith("ok realtime:")), names.join("\n"));
  });

  it("NEGATIVE CONTROL: real-time disabled (no endpoint answers) fails the very first check", async () => {
    await assert.rejects(runChecks({ noRealtimeEndpoint: true }), /refused with code \(none/);
  });

  it("fails when an anonymous socket is accepted", async () => {
    await assert.rejects(runChecks({ acceptAnonymous: true }), /timed out after 60 ms waiting for the handshake to be refused/);
  });

  it("fails when a foreign Origin is accepted", async () => {
    await assert.rejects(runChecks({ acceptAnyOrigin: true }), /timed out after 60 ms waiting for the foreign-Origin handshake/);
  });

  it("fails when an authenticated socket never becomes ready", async () => {
    await assert.rejects(runChecks({ neverReady: true }), /waiting for realtime\.ready/);
  });

  it("fails when a REST-created incident is not pushed within the bound", async () => {
    await assert.rejects(runChecks({ dropPushes: true }), /waiting for the pushed incident event/);
  });

  it("fails, counting the leaked events, when another organization's socket receives them", async () => {
    await assert.rejects(runChecks({ leakAcrossOrganizations: true }), /event\(s\) of organization A reached organization B's socket/);
  });

  it("fails when the socket is not closed after logout", async () => {
    await assert.rejects(runChecks({ neverClosesAfterLogout: true }), /waiting for the server to close the socket after logout/);
  });
});

describe("createProbe", () => {
  it("resolves immediately for an event that already happened, and rejects with a bounded timeout otherwise", async () => {
    const socket = new EventEmitter();
    const probe = createProbe(socket);
    socket.emit("realtime.ready", { organizationId: "o" });
    assert.deepEqual(await probe.waitFor("realtime.ready", () => true, 50, "ready"), { organizationId: "o" });
    const started = Date.now();
    await assert.rejects(probe.waitFor("incident.event", () => true, 40, "an event"), /timed out after 40 ms waiting for an event/);
    assert.ok(Date.now() - started < 1000);
  });

  it("resolves a pending wait as soon as the matching event arrives", async () => {
    const socket = new EventEmitter();
    const probe = createProbe(socket);
    const pending = probe.waitFor("incident.event", (m) => m.incidentId === "x", 1000, "x");
    socket.emit("incident.event", { incidentId: "y" });
    socket.emit("incident.event", { incidentId: "x" });
    assert.deepEqual(await pending, { incidentId: "x" });
  });
});
