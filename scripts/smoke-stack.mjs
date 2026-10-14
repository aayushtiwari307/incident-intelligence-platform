#!/usr/bin/env node
// End-to-end smoke test of a RUNNING stack (API + web) over real HTTP and WebSocket. HTTP half is dependency-free (Node >= 22);
// the WebSocket half loads the socket.io-client that apps/api already declares (no extra package).
//
//   node scripts/smoke-stack.mjs
//   API_URL=http://127.0.0.1:3001 WEB_URL=http://127.0.0.1:3000 node scripts/smoke-stack.mjs
//   (WEB_URL= skips the web check; SMOKE_ORIGIN overrides the Origin header, default WEB_URL;
//    SMOKE_REALTIME=off skips the WebSocket checks)
//
// It registers a throw-away user in a throw-away organization, so run it only against a local or CI stack.
// It never prints cookies, tokens or passwords. Exit code 1 on the first failed check.
//
// Real-time checks (Milestone 5) use the socket.io-client that apps/api already declares as a devDependency, so no
// new package is needed; SMOKE_REALTIME=off skips them. Every wait is event-driven with a bounded timeout.
//
// Cookie handling is done by hand on purpose: in production mode the API sets a `__Host-` prefixed `Secure` cookie,
// which a browser refuses to store from plain http except on localhost, and which Node's fetch does not store at all.
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/** Parses one Set-Cookie header into its name, value and lower-cased attributes. */
export function parseSetCookie(header) {
  const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
  const eq = pair.indexOf("=");
  const attrs = {};
  for (const attribute of attributes) {
    const i = attribute.indexOf("=");
    const key = (i === -1 ? attribute : attribute.slice(0, i)).toLowerCase();
    attrs[key] = i === -1 ? true : attribute.slice(i + 1);
  }
  return { name: pair.slice(0, eq), value: pair.slice(eq + 1), attributes: attrs };
}

/** Rules a session cookie must satisfy; returns a list of problems (empty = fine). */
export function sessionCookieProblems(cookie) {
  const problems = [];
  const a = cookie.attributes;
  if (!a.httponly) problems.push("session cookie is not HttpOnly");
  if (String(a.samesite ?? "").toLowerCase() !== "lax") problems.push("session cookie is not SameSite=Lax");
  if (cookie.name.startsWith("__Host-")) {
    if (!a.secure) problems.push("__Host- cookie is not Secure");
    if (a.path !== "/") problems.push("__Host- cookie does not have Path=/");
    if (a.domain !== undefined) problems.push("__Host- cookie must not set Domain");
  }
  return problems;
}

class SmokeFailure extends Error {}

function expect(condition, message) {
  if (!condition) throw new SmokeFailure(message);
}

const REALTIME_EVENTS = ["connect", "connect_error", "disconnect", "realtime.ready", "incident.event", "realtime.resync"];

/**
 * Wraps one client socket: records every event it receives (payloads are NEVER printed) and lets a check wait for a
 * specific one with a hard timeout. Waiting is event-driven: a waiter is re-evaluated on each event, not on a timer.
 */
export function createProbe(socket) {
  const log = [];
  const waiters = new Set();
  for (const name of REALTIME_EVENTS) {
    socket.on(name, (payload) => {
      log.push({ name, payload });
      for (const waiter of [...waiters]) waiter();
    });
  }
  return {
    log,
    has: (name, predicate = () => true) => log.some((entry) => entry.name === name && predicate(entry.payload)),
    waitFor(name, predicate, timeoutMs, what) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const hit = log.find((entry) => entry.name === name && predicate(entry.payload));
          if (!hit) return;
          cleanup();
          resolve(hit.payload);
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new SmokeFailure(`timed out after ${timeoutMs} ms waiting for ${what}`));
        }, timeoutMs);
        const cleanup = () => {
          clearTimeout(timer);
          waiters.delete(check);
        };
        waiters.add(check);
        check();
      });
    },
    close() {
      try {
        socket.close();
      } catch {
        // already closed
      }
    },
  };
}

const rejectionCode = (error) => error?.data?.code;

/** Loads the socket.io-client that apps/api declares as a devDependency (works whether npm hoisted it or not). */
export function loadSocketIoClient() {
  const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
  return require("socket.io-client").io;
}

/**
 * The WebSocket half of the smoke test. Everything the server pushes must reach exactly the right organization:
 * unauthenticated and foreign-Origin handshakes are refused, an authenticated socket becomes ready, a REST-created
 * incident arrives within `pushTimeoutMs`, another organization's socket receives nothing of it, and a socket is
 * closed after its session logs out.
 *
 * ctx supplies the HTTP side (so this function is testable with a fake socket factory):
 *   createIncident(cookie, title) -> incident id        registerOtherOrg() -> cookie of a user in ANOTHER organization
 *   loginSecondSession() -> cookie of a second session of the first user       logout(cookie) -> void
 */
export async function runRealtimeChecks(ctx) {
  const { step, socketUrl, origin, cookie, createIncident, registerOtherOrg, loginSecondSession, logout } = ctx;
  const connectTimeoutMs = ctx.connectTimeoutMs ?? 5_000;
  const pushTimeoutMs = ctx.pushTimeoutMs ?? 5_000;
  const closeTimeoutMs = ctx.closeTimeoutMs ?? 15_000;
  const open = ctx.socketFactory ?? loadSocketIoClient();
  const probes = [];
  const connect = (headers) => {
    const socket = open(socketUrl, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
      timeout: connectTimeoutMs,
      extraHeaders: headers,
    });
    const probe = createProbe(socket);
    probes.push(probe);
    return probe;
  };
  const asCookie = (value) => ({ Origin: origin, Cookie: value });
  const isIncident = (id) => (message) => message?.incidentId === id;

  try {
    await step("realtime: a socket without a session cookie is refused (UNAUTHENTICATED)", async () => {
      const probe = connect({ Origin: origin });
      const error = await probe.waitFor("connect_error", () => true, connectTimeoutMs, "the handshake to be refused");
      expect(rejectionCode(error) === "UNAUTHENTICATED", `refused with code ${rejectionCode(error) ?? "(none: no real-time endpoint answered)"}`);
      expect(!probe.has("connect") && !probe.has("realtime.ready"), "an unauthenticated socket connected");
    });

    await step("realtime: a foreign Origin is refused even with a valid session cookie", async () => {
      const probe = connect({ Origin: "https://evil.example", Cookie: cookie });
      await probe.waitFor("connect_error", () => true, connectTimeoutMs, "the foreign-Origin handshake to be refused");
      expect(!probe.has("connect") && !probe.has("realtime.ready"), "a foreign-Origin socket connected");
    });

    const first = connect(asCookie(cookie));
    await step("realtime: an authenticated socket receives realtime.ready", async () => {
      await first.waitFor("realtime.ready", () => true, connectTimeoutMs, "realtime.ready");
    });

    let incidentId;
    await step(`realtime: an incident created over REST is pushed within ${pushTimeoutMs / 1000}s`, async () => {
      incidentId = await createIncident(cookie, "Smoke: realtime push");
      await first.waitFor("incident.event", isIncident(incidentId), pushTimeoutMs, "the pushed incident event");
    });

    await step("realtime: another organization's socket receives nothing from this organization (and vice versa)", async () => {
      const otherCookie = await registerOtherOrg();
      const other = connect(asCookie(otherCookie));
      await other.waitFor("realtime.ready", () => true, connectTimeoutMs, "realtime.ready for the other organization");
      // Events are pushed strictly in commit order, so once each side has received its own LATER event, any leak of an
      // EARLIER event would already have arrived: absence is then a sound conclusion, not a sleep that happened to expire.
      const second = await createIncident(cookie, "Smoke: realtime isolation A");
      await first.waitFor("incident.event", isIncident(second), pushTimeoutMs, "own event (organization A)");
      const foreign = await createIncident(otherCookie, "Smoke: realtime isolation B");
      await other.waitFor("incident.event", isIncident(foreign), pushTimeoutMs, "own event (organization B)");
      const last = await createIncident(cookie, "Smoke: realtime isolation A2");
      await first.waitFor("incident.event", isIncident(last), pushTimeoutMs, "later own event (organization A)");
      const leakedToOther = [incidentId, second, last].filter((id) => other.has("incident.event", isIncident(id)));
      expect(leakedToOther.length === 0, `${leakedToOther.length} event(s) of organization A reached organization B's socket`);
      expect(!first.has("incident.event", isIncident(foreign)), "an event of organization B reached organization A's socket");
    });

    await step("realtime: the server closes a socket after its session logs out", async () => {
      const secondSession = await loginSecondSession();
      const probe = connect(asCookie(secondSession));
      await probe.waitFor("realtime.ready", () => true, connectTimeoutMs, "realtime.ready for the second session");
      await logout(secondSession);
      await probe.waitFor("disconnect", () => true, closeTimeoutMs, "the server to close the socket after logout");
      expect(!probe.has("incident.event"), "the closed session received an incident event");
      expect(first.log.every((entry) => entry.name !== "disconnect"), "logging out one session closed another session's socket");
    });
  } finally {
    for (const probe of probes) probe.close();
  }
}

export async function runSmoke({ apiUrl, webUrl, origin: originOverride, log = console.log, fetchImpl = fetch, realtime = true, socketFactory, realtimeOptions = {} } = {}) {
  const api = apiUrl.replace(/\/$/, "");
  const web = webUrl ? webUrl.replace(/\/$/, "") : null;
  // The Origin a browser would send from the web app; must be on the API's CORS_ORIGINS allow-list.
  const origin = originOverride ?? web ?? "http://127.0.0.1:3000";
  const email = `smoke-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url");
  let cookie = "";
  let passed = 0;

  async function http(path, { method = "GET", body, withCookie = true, originHeader = origin, cookieValue } = {}) {
    const headers = {};
    if (method !== "GET") headers.Origin = originHeader;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const sent = cookieValue ?? (withCookie ? cookie : "");
    if (sent) headers.Cookie = sent;
    const response = await fetchImpl(`${api}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { response, json, text };
  }

  async function step(name, fn) {
    try {
      await fn();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log(`FAIL ${name}: ${reason}`);
      throw error instanceof SmokeFailure ? error : new SmokeFailure(`${name}: ${reason}`);
    }
    passed++;
    log(`ok   ${name}`);
  }

  function takeCookie(response) {
    const headers = response.headers.getSetCookie();
    expect(headers.length === 1, `expected exactly one Set-Cookie header, got ${headers.length}`);
    const parsed = parseSetCookie(headers[0]);
    const problems = sessionCookieProblems(parsed);
    expect(problems.length === 0, problems.join("; "));
    cookie = `${parsed.name}=${parsed.value}`;
    return parsed;
  }

  await step("API liveness", async () => {
    const { response, json } = await http("/health/live");
    expect(response.status === 200 && json?.status === "ok", `status ${response.status}`);
  });
  await step("API readiness (database reachable)", async () => {
    const { response, json } = await http("/health/ready");
    expect(response.status === 200 && json?.database === "up", `status ${response.status}`);
  });
  if (web) {
    await step("web login page renders", async () => {
      const response = await fetchImpl(`${web}/login`, { signal: AbortSignal.timeout(15_000) });
      const html = await response.text();
      expect(response.status === 200, `status ${response.status}`);
      expect((response.headers.get("content-type") ?? "").includes("text/html"), "not HTML");
      expect(/<html/i.test(html), "response is not an HTML document");
    });
  }

  await step("request from a foreign Origin is rejected before any work happens (CSRF defence)", async () => {
    const { response, json } = await http("/api/auth/register", {
      method: "POST",
      originHeader: "https://evil.example",
      body: { email, password, displayName: "Smoke", organizationName: "Smoke Org" },
      withCookie: false,
    });
    expect(response.status === 403 && json?.error?.code === "ORIGIN_NOT_ALLOWED", `status ${response.status}`);
  });
  await step("registration creates the user and a hardened session cookie", async () => {
    const { response, json } = await http("/api/auth/register", {
      method: "POST",
      body: { email, password, displayName: "Smoke Tester", organizationName: "Smoke Org" },
      withCookie: false,
    });
    expect(response.status === 201, `status ${response.status}`);
    expect(json?.user?.email === email && json?.role === "owner", "unexpected /me shape");
    takeCookie(response);
  });
  await step("session identifies the caller", async () => {
    const { response, json } = await http("/api/auth/me");
    expect(response.status === 200 && json?.user?.email === email, `status ${response.status}`);
  });

  let incident;
  await step("create an incident", async () => {
    const { response, json } = await http("/api/incidents", {
      method: "POST",
      body: { title: "Smoke: API response time high", description: "created by scripts/smoke-stack.mjs", severity: "sev2" },
    });
    expect(response.status === 201, `status ${response.status}`);
    expect(json?.status === "triggered" && json?.version === 1 && json?.number === 1, "unexpected incident shape");
    incident = json;
  });
  await step("incident appears in the list", async () => {
    const { response, json } = await http("/api/incidents");
    expect(response.status === 200 && json?.items?.some((item) => item.id === incident.id), `status ${response.status}`);
  });
  await step("status transition succeeds, and a stale version is a 409", async () => {
    const ok = await http(`/api/incidents/${incident.id}/transitions`, { method: "POST", body: { to: "acknowledged", expectedVersion: 1 } });
    expect(ok.response.status === 200 && ok.json?.status === "acknowledged" && ok.json?.version === 2, `status ${ok.response.status}`);
    const stale = await http(`/api/incidents/${incident.id}/transitions`, { method: "POST", body: { to: "investigating", expectedVersion: 1 } });
    expect(stale.response.status === 409, `stale status ${stale.response.status}`);
  });
  await step("timeline recorded the lifecycle", async () => {
    const { response, json } = await http(`/api/incidents/${incident.id}/timeline`);
    const types = (json?.items ?? []).map((item) => item.type);
    expect(response.status === 200 && types.includes("created") && types.includes("status_changed"), `types: ${types.join(",")}`);
  });
  await step("AI analysis state is consistent with the configuration", async () => {
    const state = await http(`/api/incidents/${incident.id}/analysis`);
    expect(state.response.status === 200 && typeof state.json?.enabled === "boolean", `status ${state.response.status}`);
    if (!state.json.enabled) {
      expect(state.json.analysis === null, "analysis exists although AI is disabled");
      const request = await http(`/api/incidents/${incident.id}/analysis`, { method: "POST" });
      expect(request.response.status === 409 && request.json?.error?.code === "FEATURE_DISABLED", `status ${request.response.status}`);
    }
  });

  if (realtime) {
    const cookieOf = (response) => {
      const headers = response.headers.getSetCookie();
      expect(headers.length === 1, `expected exactly one Set-Cookie header, got ${headers.length}`);
      const parsed = parseSetCookie(headers[0]);
      const problems = sessionCookieProblems(parsed);
      expect(problems.length === 0, problems.join("; "));
      return `${parsed.name}=${parsed.value}`;
    };
    await runRealtimeChecks({
      step,
      socketUrl: api,
      origin,
      cookie,
      socketFactory,
      ...realtimeOptions,
      createIncident: async (cookieValue, title) => {
        const { response, json } = await http("/api/incidents", { method: "POST", cookieValue, body: { title, description: "created by scripts/smoke-stack.mjs", severity: "sev3" } });
        expect(response.status === 201 && typeof json?.id === "string", `incident create status ${response.status}`);
        return json.id;
      },
      registerOtherOrg: async () => {
        const otherEmail = `smoke-other-${randomBytes(6).toString("hex")}@example.com`;
        const { response } = await http("/api/auth/register", {
          method: "POST",
          withCookie: false,
          body: { email: otherEmail, password, displayName: "Smoke Other", organizationName: "Smoke Other Org" },
        });
        expect(response.status === 201, `second organization registration status ${response.status}`);
        return cookieOf(response);
      },
      loginSecondSession: async () => {
        const { response } = await http("/api/auth/login", { method: "POST", withCookie: false, body: { email, password } });
        expect(response.status === 200, `second session login status ${response.status}`);
        return cookieOf(response);
      },
      logout: async (cookieValue) => {
        const { response } = await http("/api/auth/logout", { method: "POST", cookieValue });
        expect(response.status === 204, `logout status ${response.status}`);
      },
    });
  }

  await step("requests without a session are 401", async () => {
    const { response } = await http("/api/auth/me", { withCookie: false });
    expect(response.status === 401, `status ${response.status}`);
  });
  const oldCookie = cookie;
  await step("logout revokes the session on the server", async () => {
    const { response } = await http("/api/auth/logout", { method: "POST" });
    expect(response.status === 204, `status ${response.status}`);
    cookie = oldCookie; // replay the old cookie: it must be dead even though the client still holds it
    const replay = await http("/api/auth/me");
    expect(replay.response.status === 401, `replayed cookie status ${replay.response.status}`);
  });
  await step("login with the password works and a wrong password does not", async () => {
    const bad = await http("/api/auth/login", { method: "POST", withCookie: false, body: { email, password: `${password}x` } });
    expect(bad.response.status === 401, `wrong password status ${bad.response.status}`);
    const good = await http("/api/auth/login", { method: "POST", withCookie: false, body: { email, password } });
    expect(good.response.status === 200, `status ${good.response.status}`);
    takeCookie(good.response);
    const { response } = await http("/api/incidents");
    expect(response.status === 200, `status ${response.status}`);
  });

  log(`smoke test passed (${passed} checks)`);
  return passed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3001";
  const webUrl = process.env.WEB_URL === "" ? null : (process.env.WEB_URL ?? "http://127.0.0.1:3000");
  runSmoke({ apiUrl, webUrl, origin: process.env.SMOKE_ORIGIN, realtime: process.env.SMOKE_REALTIME !== "off" }).catch((error) => {
    console.error(`smoke test FAILED: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
