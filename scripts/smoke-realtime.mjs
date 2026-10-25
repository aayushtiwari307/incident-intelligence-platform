#!/usr/bin/env node
// Read-only authenticated Socket.IO smoke check. Does not create incidents or write to the API.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export function validateSmokeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("IIP_SMOKE_URL must be an absolute HTTP(S) URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("IIP_SMOKE_URL must use HTTP(S)");
  if (url.username || url.password || url.search || url.hash) throw new Error("IIP_SMOKE_URL must not contain credentials, query parameters, or a fragment");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("Refusing cleartext HTTP for a non-loopback smoke target");
  }
  url.pathname = "/";
  return url.origin;
}

export async function runRealtimeSmoke({
  url = process.env.IIP_SMOKE_URL,
  cookie = process.env.IIP_SMOKE_COOKIE,
  timeoutMs = 8_000,
  log = console.log,
} = {}) {
  if (!url) throw new Error("Set IIP_SMOKE_URL to the deployed API origin");
  if (!cookie || /[\r\n]/.test(cookie)) throw new Error("Set IIP_SMOKE_COOKIE to a valid session Cookie header; it will not be printed");
  const origin = validateSmokeUrl(url);
  const require = createRequire(import.meta.url);
  let io;
  try { ({ io } = require("socket.io-client")); } catch { throw new Error("socket.io-client is not installed; run npm ci first"); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(error); else resolve();
    };
    const socket = io(origin, {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: false,
      timeout: timeoutMs,
      extraHeaders: { cookie, origin },
    });
    const timer = setTimeout(() => finish(new Error(`Timed out after ${timeoutMs} ms waiting for realtime.ready`)), timeoutMs);
    socket.once("connect", () => log("WebSocket handshake connected; awaiting authenticated realtime.ready"));
    socket.once("realtime.ready", () => {
      log("PASS: authenticated real-time connection is ready. Payloads were not logged; no writes were sent.");
      finish();
    });
    socket.once("connect_error", (error) => finish(new Error(`WebSocket handshake failed (${String(error?.data?.code ?? error?.message ?? "connection error").replace(/[\r\n]/g, " ").slice(0, 100)})`)));
    socket.once("disconnect", (reason) => {
      if (!settled) finish(new Error(`WebSocket disconnected before ready (${String(reason).slice(0, 80)})`));
    });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runRealtimeSmoke().catch((error) => {
    console.error(`smoke-realtime: ${error instanceof Error ? error.message : "smoke failed"}`);
    process.exitCode = 1;
  });
}
