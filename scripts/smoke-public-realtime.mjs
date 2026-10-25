#!/usr/bin/env node
// READ-ONLY smoke test of the real-time path of a DEPLOYED instance (for example the Render demo).
//
//   set PUBLIC_URL=https://your-service.onrender.com
//   node scripts/smoke-public-realtime.mjs
//
// Environment (all optional except PUBLIC_URL):
//   PUBLIC_URL            origin of the deployment; https required unless the host is loopback
//   EXPECT_REALTIME       "on" (default) or "off". With "off" the script PASSES when real-time is not served and FAILS if it is.
//   WAKE_TIMEOUT_SECONDS  how long to wait for a sleeping free-tier instance to answer /health (default 120, max 300)
//   SMOKE_SESSION_COOKIE  optional full "name=value" session cookie of an existing user. When set, one authenticated
//                         socket must receive realtime.ready. Taken from the environment at run time and NEVER printed.
//
// What it does NOT do: it never registers, logs in, creates or changes anything. It only issues GET /health/* requests and
// opens WebSocket handshakes (which the server either refuses or accepts for an existing session). That is the difference
// from scripts/smoke-stack.mjs, which registers throw-away users and must only ever run against a local or CI stack.
//
// It cannot replace the two-browser acceptance test (docs/deployment/realtime-rollout.md): that proves a change made in
// one browser appears in another, which needs two real sessions.
//
// Fails closed: any unexpected state exits 1, and "PASS" is printed only after every check ran and passed.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const REALTIME_PATH = "/socket.io";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export class SmokeFailure extends Error {}

/**
 * Validates PUBLIC_URL and returns its origin. Rejects anything that could leak or mis-target a request: credentials in the
 * URL, a path/query/fragment, a non-https scheme for a non-loopback host.
 */
export function parseTarget(value) {
  if (typeof value !== "string" || value.trim() === "") throw new SmokeFailure("PUBLIC_URL is required (for example https://your-service.onrender.com)");
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new SmokeFailure("PUBLIC_URL is not a valid URL");
  }
  if (url.username || url.password) throw new SmokeFailure("PUBLIC_URL must not contain credentials");
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new SmokeFailure("PUBLIC_URL must be a bare origin (no path, query or fragment)");
  const loopback = LOOPBACK.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new SmokeFailure("PUBLIC_URL must use https (http is accepted only for localhost)");
  }
  return url.origin;
}

export function parseExpectation(value) {
  const v = (value ?? "on").trim().toLowerCase();
  if (v === "on" || v === "off") return v;
  throw new SmokeFailure('EXPECT_REALTIME must be "on" or "off"');
}

export function parseWakeTimeout(value) {
  if (value === undefined || value.trim() === "") return 120;
  if (!/^\d+$/.test(value.trim())) throw new SmokeFailure("WAKE_TIMEOUT_SECONDS must be an integer");
  const seconds = Number(value.trim());
  if (seconds < 5 || seconds > 300) throw new SmokeFailure("WAKE_TIMEOUT_SECONDS must be between 5 and 300");
  return seconds;
}

/**
 * Interprets the outcome of an UNAUTHENTICATED handshake from an allowed origin.
 *   enabled   the server answered and refused us for lack of a session: real-time is served and authenticates
 *   disabled  the handshake failed with a transport-level error and no application-level refusal (404, no route): not served
 *   unexpected anything else, including a connection that succeeded (which would be a security problem)
 */
export function classifyUnauthenticated(outcome) {
  if (outcome.connected) return "unexpected";
  if (!outcome.errored) return "unexpected"; // nothing happened before the timeout: neither enabled nor provably disabled
  if (outcome.errorCode === "UNAUTHENTICATED") return "enabled";
  if (outcome.errorCode === undefined) return "disabled";
  return "unexpected";
}

/** A foreign origin must never connect; any refusal (application-level or transport-level) is acceptable. */
export function foreignOriginRefused(outcome) {
  return !outcome.connected && !outcome.ready;
}

/** Loads the socket.io-client that apps/api declares as a devDependency (the same one scripts/smoke-stack.mjs uses). */
export function loadSocketIoClient() {
  const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
  return require("socket.io-client").io;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchStatus(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // redirect: "manual" so a redirect to another host is reported, never silently followed.
    const response = await fetch(url, { method: "GET", redirect: "manual", signal: controller.signal });
    return response.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/** Waits for a sleeping free-tier instance: polls until the endpoint answers 200 or the deadline passes. */
export async function waitForHealth(url, deadlineMs, { fetchOnce = fetchStatus, pause = sleep, now = Date.now } = {}) {
  const started = now();
  let last = 0;
  for (;;) {
    last = await fetchOnce(url, 10_000);
    if (last === 200) return { ok: true, status: last, waitedMs: now() - started };
    if (now() - started >= deadlineMs) return { ok: false, status: last, waitedMs: now() - started };
    await pause(5_000);
  }
}

/** Opens one WebSocket-only handshake and reports what happened. Payloads and the cookie are never printed. */
function handshake(open, origin, { headers, timeoutMs }) {
  return new Promise((resolve) => {
    const socket = open(origin, { path: REALTIME_PATH, transports: ["websocket"], reconnection: false, forceNew: true, timeout: timeoutMs, extraHeaders: headers });
    const outcome = { connected: false, ready: false, errored: false, errorCode: undefined };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(outcome);
    };
    const timer = setTimeout(finish, timeoutMs + 1_000);
    socket.on("connect", () => {
      outcome.connected = true;
    });
    socket.on("realtime.ready", () => {
      outcome.ready = true;
      finish();
    });
    socket.on("connect_error", (error) => {
      outcome.errored = true;
      outcome.errorCode = error?.data?.code;
      finish();
    });
  });
}

export async function run(env = process.env, io = { open: undefined, log: console.log }) {
  const log = io.log;
  const results = [];
  const check = (name, passed, detail) => {
    results.push({ name, passed });
    log(`${passed ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  };

  const origin = parseTarget(env.PUBLIC_URL);
  const expectation = parseExpectation(env.EXPECT_REALTIME);
  const wakeSeconds = parseWakeTimeout(env.WAKE_TIMEOUT_SECONDS);
  const cookie = env.SMOKE_SESSION_COOKIE && env.SMOKE_SESSION_COOKIE.trim() !== "" ? env.SMOKE_SESSION_COOKIE.trim() : undefined;
  log(`target ${origin}; expecting real-time ${expectation}; authenticated check ${cookie ? "requested" : "skipped (no SMOKE_SESSION_COOKIE)"}`);

  const live = await waitForHealth(`${origin}/health/live`, wakeSeconds * 1000);
  check("GET /health/live answers 200", live.ok, `status ${live.status}, waited ${Math.round(live.waitedMs / 1000)}s`);
  if (!live.ok) return finalize(results, log);
  const ready = await waitForHealth(`${origin}/health/ready`, 30_000);
  check("GET /health/ready answers 200", ready.ok, `status ${ready.status}`);

  const open = io.open ?? loadSocketIoClient();
  const unauth = await handshake(open, origin, { headers: { Origin: origin }, timeoutMs: 8_000 });
  const verdict = classifyUnauthenticated(unauth);

  if (expectation === "off") {
    check("real-time is NOT served (EXPECT_REALTIME=off)", verdict === "disabled", `verdict ${verdict}`);
    return finalize(results, log);
  }
  check("real-time is served and an unauthenticated socket is refused with UNAUTHENTICATED", verdict === "enabled", `verdict ${verdict}`);
  if (verdict !== "enabled") return finalize(results, log);

  const foreign = await handshake(open, origin, { headers: { Origin: "https://evil.example", ...(cookie ? { Cookie: cookie } : {}) }, timeoutMs: 8_000 });
  check("a foreign Origin is refused", foreignOriginRefused(foreign));

  if (cookie) {
    const authed = await handshake(open, origin, { headers: { Origin: origin, Cookie: cookie }, timeoutMs: 15_000 });
    check("an authenticated socket receives realtime.ready", authed.ready, authed.ready ? undefined : `error code ${authed.errorCode ?? "none"}`);
  }
  return finalize(results, log);
}

function finalize(results, log) {
  const failed = results.filter((r) => !r.passed).length;
  if (failed === 0 && results.length > 0) {
    log(`PASS: ${results.length} check(s) passed`);
    return 0;
  }
  log(`FAIL: ${failed} of ${results.length} check(s) failed`);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`FAIL: ${error instanceof SmokeFailure ? error.message : "unexpected error"}`);
      process.exit(1);
    },
  );
}
