#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import path from "node:path";

export const DEFAULT_CHANGE_URL = "http://127.0.0.1:3001/api/v1/integrations/changes";

export function isLoopbackHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const octets = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$/.exec(host);
  return Boolean(octets && Number(octets[1]) === 127 && octets.slice(1).every((part) => Number(part) <= 255));
}

export function resolveChangeTarget(value = DEFAULT_CHANGE_URL) {
  let url;
  try { url = new URL(value); } catch { throw new Error("IIP_CHANGE_SIMULATOR_URL must be a valid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Simulator supports only HTTP(S)");
  if (url.username || url.password) throw new Error("Do not put credentials in the URL; use IIP_CHANGE_TOKEN");
  if (!isLoopbackHost(url.hostname)) throw new Error("Refusing to send a synthetic change event to a non-loopback host");
  if (!url.pathname.endsWith("/api/v1/integrations/changes")) throw new Error("Simulator URL must end in /api/v1/integrations/changes");
  return url.toString();
}

export async function simulateChange({
  url = DEFAULT_CHANGE_URL,
  token = process.env.IIP_CHANGE_TOKEN,
  service = process.env.IIP_CHANGE_SERVICE,
  source = process.env.IIP_CHANGE_SOURCE || "local-simulator",
  externalId = process.env.IIP_CHANGE_EXTERNAL_ID || "sample-deploy-1",
  version = process.env.IIP_CHANGE_VERSION || "local-build",
  actor = process.env.IIP_CHANGE_ACTOR || "local-simulator",
  fetchImpl = fetch,
  log = console.log,
  now = () => new Date(),
} = {}) {
  if (!token || /\s/.test(token)) throw new Error("Set IIP_CHANGE_TOKEN to the one-time change-events integration token");
  if (!service?.trim()) throw new Error("Set IIP_CHANGE_SERVICE to the exact name of a service in the local organization");
  const target = resolveChangeTarget(url);
  const payload = { service, source, externalId, version, actor, timestamp: now().toISOString() };
  const response = await fetchImpl(target, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const code = body?.error?.code;
    throw new Error(`Change simulator request failed: HTTP ${response.status}${code ? ` (${String(code).slice(0, 60)})` : ""}`);
  }
  if (body?.accepted !== true || typeof body?.duplicate !== "boolean") throw new Error("Change simulator received an unexpected response contract");
  log(`Local change event ${body.duplicate ? "was already recorded" : "was accepted"}; event id ${String(body.changeEventId ?? "unavailable")}`);
  return body;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  simulateChange({ url: process.env.IIP_CHANGE_SIMULATOR_URL || DEFAULT_CHANGE_URL }).catch((error) => {
    console.error(`simulate-change: ${error instanceof Error ? error.message : "request failed"}`);
    process.exitCode = 1;
  });
}
