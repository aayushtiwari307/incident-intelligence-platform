#!/usr/bin/env node
// SYNTHETIC Alertmanager simulator for LOCAL testing of the Milestone 7 webhook. It sends ONLY made-up data.
//
//   set ALERTMANAGER_SIM_TOKEN=<integration token>          (cmd.exe)   |   $env:ALERTMANAGER_SIM_TOKEN="<token>"   (PowerShell)
//   npm run simulate:alertmanager
//   npm run simulate:alertmanager -- --base-url http://127.0.0.1:3001
//
// What it does (one synthetic alert cycle, random fingerprint, so every run is a NEW cycle):
//   1. sends a "firing" notification            -> expects exactly one incident to be created
//   2. sends the IDENTICAL firing notification  -> expects the same incident, delivery count 2, nothing new created
//   3. sends the "resolved" notification        -> expects the same incident to be resolved, delivery count 3
//   4. sends an empty-body probe with an invalid bearer token -> expects 401 UNAUTHENTICATED before body validation
//      (the empty alerts array prevents a broken auth check from creating a second synthetic incident)
// It then reports PASS/FAIL per expectation. Exit code 1 on any mismatch.
//
// SAFETY: the token is read from the environment and is never printed. The destination must be a loopback address
// (127.0.0.0/8, ::1, localhost) unless --allow-non-loopback is passed explicitly. The run creates ONE synthetic incident,
// in the organization that owns the integration whose token you supply: use a throw-away local organization.
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "http://127.0.0.1:8080";
export const WEBHOOK_PATH = "/api/v1/integrations/alertmanager";

/** True for localhost, 127.0.0.0/8 and ::1. Everything else (including unresolvable names) is NOT loopback. */
export function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return m !== null && Number(m[1]) === 127 && m.slice(1).every((part) => Number(part) <= 255);
}

/** Validates the destination and returns the webhook URL; throws with a clear message otherwise. */
export function resolveTarget(baseUrl, { allowNonLoopback = false } = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only http and https destinations are supported");
  if (url.username || url.password) throw new Error("Credentials in the URL are not allowed; use ALERTMANAGER_SIM_TOKEN");
  if (!allowNonLoopback && !isLoopbackHost(url.hostname)) {
    throw new Error(`Refusing to send synthetic alerts to non-loopback host "${url.hostname}". Use a local stack, or pass --allow-non-loopback if you really mean it.`);
  }
  return new URL(WEBHOOK_PATH, url.origin).toString();
}

/** A standard Alertmanager webhook v4 body for ONE synthetic alert. */
export function buildPayload({ status, fingerprint, startsAt, endsAt }) {
  return {
    version: "4",
    groupKey: `{}:{alertname="SyntheticSimulatorAlert"}`,
    truncatedAlerts: 0,
    status,
    receiver: "synthetic-simulator",
    groupLabels: { alertname: "SyntheticSimulatorAlert" },
    commonLabels: { alertname: "SyntheticSimulatorAlert", severity: "warning", synthetic: "true" },
    commonAnnotations: { summary: "SYNTHETIC test alert (simulate-alertmanager.mjs)" },
    externalURL: "http://alertmanager.invalid:9093",
    alerts: [
      {
        status,
        labels: { alertname: "SyntheticSimulatorAlert", severity: "warning", synthetic: "true" },
        annotations: { summary: "SYNTHETIC test alert (simulate-alertmanager.mjs)", description: "Created by the local synthetic simulator. Safe to resolve or ignore." },
        startsAt,
        endsAt: status === "resolved" ? endsAt : "0001-01-01T00:00:00Z",
        generatorURL: "http://prometheus.invalid:9090/graph",
        fingerprint,
      },
    ],
  };
}

/** The documented contract, as expectations on the four responses. Returns a list of {name, ok, detail}. */
export function checkResponses([first, second, third, authFailure]) {
  const item = (r) => r?.json?.results?.[0];
  const checks = [
    { name: "firing delivery accepted (HTTP 200)", ok: first?.status === 200, detail: `status ${first?.status}` },
    { name: "firing delivery created exactly one incident", ok: item(first)?.result === "created" && first?.json?.created === 1, detail: `result ${item(first)?.result}` },
    { name: "identical firing delivery accepted (HTTP 200)", ok: second?.status === 200, detail: `status ${second?.status}` },
    { name: "identical firing delivery was a duplicate (no second incident)", ok: item(second)?.result === "duplicate" && second?.json?.created === 0, detail: `result ${item(second)?.result}` },
    { name: "duplicate points at the same incident", ok: !!item(first)?.incidentId && item(second)?.incidentId === item(first)?.incidentId, detail: "incident ids compared" },
    { name: "duplicate delivery was counted (deliveryCount 2)", ok: item(second)?.deliveryCount === 2, detail: `deliveryCount ${item(second)?.deliveryCount}` },
    { name: "resolved delivery accepted (HTTP 200)", ok: third?.status === 200, detail: `status ${third?.status}` },
    { name: "resolved delivery resolved the same incident once", ok: item(third)?.result === "resolved" && third?.json?.resolved === 1 && item(third)?.incidentId === item(first)?.incidentId, detail: `result ${item(third)?.result}` },
    { name: "resolved delivery was counted (deliveryCount 3)", ok: item(third)?.deliveryCount === 3, detail: `deliveryCount ${item(third)?.deliveryCount}` },
    { name: "invalid bearer token is rejected (HTTP 401)", ok: authFailure?.status === 401, detail: `status ${authFailure?.status}` },
    { name: "invalid bearer token reports UNAUTHENTICATED", ok: authFailure?.json?.error?.code === "UNAUTHENTICATED", detail: `error ${authFailure?.json?.error?.code}` },
  ];
  return checks;
}

/** Runs the three deliveries. `fetchImpl`, `now` and `random` are injectable for tests. Never logs the token. */
export async function run({ baseUrl = DEFAULT_BASE_URL, token, allowNonLoopback = false, fetchImpl = fetch, now = () => new Date(), random = () => randomBytes(6).toString("hex"), log = console.log }) {
  if (!token || /\s/.test(token)) throw new Error("Set ALERTMANAGER_SIM_TOKEN to the integration token (create one on the Team page; it is shown once).");
  const url = resolveTarget(baseUrl, { allowNonLoopback });
  const fingerprint = `sim${random()}`;
  const startsAt = new Date(now().getTime() - 60_000).toISOString();
  const endsAt = new Date(now().getTime()).toISOString();
  log(`SYNTHETIC simulator -> ${url}`);
  log(`synthetic alert cycle: fingerprint=${fingerprint} startsAt=${startsAt}`);

  const send = async (label, payload, { bearerToken = token } = {}) => {
    let response;
    try {
      response = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${bearerToken}` }, body: JSON.stringify(payload) });
    } catch (error) {
      throw new Error(`${label}: request failed (${error instanceof Error ? error.message.replaceAll(token, "[token]") : "network error"})`);
    }
    let json;
    try {
      json = await response.json();
    } catch {
      json = undefined;
    }
    const first = json?.results?.[0];
    log(`${label}: HTTP ${response.status}` + (first ? ` result=${first.result} incident=#${first.incidentNumber ?? "-"} deliveryCount=${first.deliveryCount ?? "-"}` : json?.error ? ` error=${json.error.code}` : ""));
    return { status: response.status, json };
  };

  const authProbe = buildPayload({ status: "firing", fingerprint: `sim-auth-${random()}`, startsAt });
  authProbe.alerts = []; // auth must reject before validation; if it does not, this probe still cannot create an incident.
  const invalidToken = "X".repeat(43) === token ? "Y".repeat(43) : "X".repeat(43);
  const responses = [
    await send("1/3 firing          ", buildPayload({ status: "firing", fingerprint, startsAt })),
    await send("2/3 firing (repeat) ", buildPayload({ status: "firing", fingerprint, startsAt })),
    await send("3/3 resolved        ", buildPayload({ status: "resolved", fingerprint, startsAt, endsAt })),
    await send("4/4 invalid token    ", authProbe, { bearerToken: invalidToken }),
  ];
  const checks = checkResponses(responses);
  for (const c of checks) log(`${c.ok ? "PASS" : "FAIL"} ${c.name}${c.ok ? "" : ` (${c.detail})`}`);
  const failed = checks.filter((c) => !c.ok).length;
  log(failed === 0 ? `All ${checks.length} checks passed. One synthetic incident was created and resolved; invalid credentials were rejected.` : `${failed} of ${checks.length} checks FAILED.`);
  return { ok: failed === 0, checks };
}

function parseArgs(argv) {
  const out = { baseUrl: process.env.SIM_BASE_URL || DEFAULT_BASE_URL, allowNonLoopback: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base-url") out.baseUrl = argv[++i] ?? "";
    else if (argv[i] === "--allow-non-loopback") out.allowNonLoopback = true;
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const { ok } = await run({ ...args, token: process.env.ALERTMANAGER_SIM_TOKEN });
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`simulate-alertmanager: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
