#!/usr/bin/env node
// End-to-end smoke test of a RUNNING stack (API + web) over real HTTP. Dependency-free (Node >= 22).
//
//   node scripts/smoke-stack.mjs
//   API_URL=http://127.0.0.1:3001 WEB_URL=http://127.0.0.1:3000 node scripts/smoke-stack.mjs
//   (WEB_URL= skips the web check; SMOKE_ORIGIN overrides the Origin header, default WEB_URL)
//
// It registers a throw-away user in a throw-away organization, so run it only against a local or CI stack.
// It never prints cookies, tokens or passwords. Exit code 1 on the first failed check.
//
// Cookie handling is done by hand on purpose: in production mode the API sets a `__Host-` prefixed `Secure` cookie,
// which a browser refuses to store from plain http except on localhost, and which Node's fetch does not store at all.
import { randomBytes } from "node:crypto";
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

export async function runSmoke({ apiUrl, webUrl, origin: originOverride, log = console.log, fetchImpl = fetch } = {}) {
  const api = apiUrl.replace(/\/$/, "");
  const web = webUrl ? webUrl.replace(/\/$/, "") : null;
  // The Origin a browser would send from the web app; must be on the API's CORS_ORIGINS allow-list.
  const origin = originOverride ?? web ?? "http://127.0.0.1:3000";
  const email = `smoke-${randomBytes(6).toString("hex")}@example.com`;
  const password = randomBytes(18).toString("base64url");
  let cookie = "";
  let passed = 0;

  async function http(path, { method = "GET", body, withCookie = true, originHeader = origin } = {}) {
    const headers = {};
    if (method !== "GET") headers.Origin = originHeader;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (withCookie && cookie) headers.Cookie = cookie;
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
  runSmoke({ apiUrl, webUrl, origin: process.env.SMOKE_ORIGIN }).catch((error) => {
    console.error(`smoke test FAILED: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  });
}
