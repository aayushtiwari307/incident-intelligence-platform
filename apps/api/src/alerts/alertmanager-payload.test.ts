import assert from "node:assert/strict";
import { AppError } from "../common/errors";
import { cleanLine, mapSeverity, normalizeRfc3339, parseAlertmanagerPayload } from "./alertmanager-payload";

const NOW = new Date("2026-10-15T12:00:00Z");

const alert = (over: Record<string, unknown> = {}) => ({
  status: "firing",
  labels: { alertname: "HighLatency", severity: "critical", job: "api", instance: "10.0.0.1:9100" },
  annotations: { summary: "p99 latency above 2s", description: "Latency has been high for 10 minutes" },
  startsAt: "2026-10-15T10:00:00.123456789Z",
  endsAt: "0001-01-01T00:00:00Z",
  generatorURL: "http://prometheus.example/graph?g0.expr=up",
  fingerprint: "3a1b2c3d4e5f6a7b",
  ...over,
});

const payload = (over: Record<string, unknown> = {}, alerts: unknown[] = [alert()]) => ({
  version: "4",
  groupKey: '{}:{alertname="HighLatency"}',
  truncatedAlerts: 0,
  status: "firing",
  receiver: "incident-platform",
  groupLabels: { alertname: "HighLatency" },
  commonLabels: { alertname: "HighLatency", severity: "critical" },
  commonAnnotations: { summary: "p99 latency above 2s" },
  externalURL: "http://alertmanager.example:9093",
  notification_reason: "resolved_alert",
  alerts,
  ...over,
});

function failure(fn: () => unknown): AppError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    return error;
  }
  assert.fail("expected an AppError");
}

function hasDetailMessage(error: AppError, expected: string): boolean {
  return Array.isArray(error.details) && error.details.some((detail: unknown) => {
    if (typeof detail !== "object" || detail === null || !("message" in detail)) return false;
    const message = (detail as { message?: unknown }).message;
    return typeof message === "string" && message.includes(expected);
  });
}
describe("RFC 3339 normalisation", () => {
  it("converts to UTC and truncates (not rounds) to microseconds", () => {
    assert.equal(normalizeRfc3339("2026-10-15T10:00:00.123456789Z")?.iso, "2026-10-15T10:00:00.123456Z");
    assert.equal(normalizeRfc3339("2026-10-15T15:30:00+05:30")?.iso, "2026-10-15T10:00:00.000000Z");
    assert.equal(normalizeRfc3339("2026-10-15T04:00:00-06:00")?.iso, "2026-10-15T10:00:00.000000Z");
    assert.equal(normalizeRfc3339("2026-10-15T10:00:00.5z")?.iso, "2026-10-15T10:00:00.500000Z");
  });

  it("two spellings of one instant give the same dedupe string", () => {
    assert.equal(normalizeRfc3339("2026-10-15T10:00:00Z")?.iso, normalizeRfc3339("2026-10-15T15:30:00.000+05:30")?.iso);
  });

  it("rejects things that are not real RFC 3339 timestamps", () => {
    for (const bad of ["", "yesterday", "2026-10-15", "2026-10-15 10:00:00Z", "2026-13-01T00:00:00Z", "2026-02-30T00:00:00Z", "2026-10-15T24:00:00Z",
      "2026-10-15T10:60:00Z", "2026-10-15T10:00:60Z", "2026-10-15T10:00:00", "2026-10-15T10:00:00+24:00", "2026-10-15T10:00:00+05:60", "2026-10-15T10:00:00.Z", "1e3"]) {
      assert.equal(normalizeRfc3339(bad), null, bad);
    }
  });
});

describe("severity mapping", () => {
  it("maps known labels case-insensitively", () => {
    assert.equal(mapSeverity("critical"), "sev1");
    assert.equal(mapSeverity(" CRITICAL "), "sev1");
    assert.equal(mapSeverity("Error"), "sev2");
    assert.equal(mapSeverity("warning"), "sev3");
    assert.equal(mapSeverity("info"), "sev4");
    assert.equal(mapSeverity("p2"), "sev2");
  });

  it("missing and unknown (including prototype-ish) values deterministically map to sev3", () => {
    assert.equal(mapSeverity(undefined), "sev3");
    assert.equal(mapSeverity(""), "sev3");
    assert.equal(mapSeverity("catastrophic"), "sev3");
    assert.equal(mapSeverity("constructor"), "sev3");
    assert.equal(mapSeverity("__proto__"), "sev3");
  });
});

describe("standard v4 payloads", () => {
  it("accepts a firing notification and projects only bounded fields", () => {
    const { alerts } = parseAlertmanagerPayload(payload(), NOW);
    assert.equal(alerts.length, 1);
    const a = alerts[0]!;
    assert.equal(a.status, "firing");
    assert.equal(a.fingerprint, "3a1b2c3d4e5f6a7b");
    assert.equal(a.startsAt, "2026-10-15T10:00:00.123456Z");
    assert.equal(a.endsAt, null, "Go zero time means still firing");
    assert.equal(a.severity, "sev1");
    assert.equal(a.title, "HighLatency: p99 latency above 2s");
    assert.equal(a.serviceName, null, "a missing service label must not link an incident to an arbitrary catalog entry");
    assert.match(a.description, /Summary: p99 latency above 2s/);
    assert.match(a.description, /Labels: alertname=HighLatency, severity=critical, job=api, instance=10\.0\.0\.1:9100/);
    assert.ok(!a.description.includes("prometheus.example"), "generatorURL is never stored");
    assert.ok(!a.description.includes("alertmanager.example"), "externalURL is never stored");
  });

  it("accepts a resolved notification with a real endsAt and offsets", () => {
    const { alerts } = parseAlertmanagerPayload(
      payload({ status: "resolved" }, [alert({ status: "resolved", endsAt: "2026-10-15T15:40:00+05:30", startsAt: "2026-10-15T15:30:00+05:30" })]),
      NOW,
    );
    assert.equal(alerts[0]!.status, "resolved");
    assert.equal(alerts[0]!.endsAt, "2026-10-15T10:10:00.000000Z");
    assert.equal(alerts[0]!.startsAt, "2026-10-15T10:00:00.000000Z");
  });

  it("tolerates documented optional/unknown fields and ignores them (routeLabels, notification_reason, future keys)", () => {
    const p = payload({ routeLabels: { team: "sre" }, someFutureField: { nested: true } }, [alert({ extra: "x" })]);
    assert.equal(parseAlertmanagerPayload(p, NOW).alerts.length, 1);
    const minimal = { version: "4", status: "firing", alerts: [{ status: "firing", labels: {}, startsAt: "2026-10-15T10:00:00Z", fingerprint: "ab" }] };
    const parsed = parseAlertmanagerPayload(minimal, NOW).alerts[0]!;
    assert.equal(parsed.title, "Alertmanager alert");
    assert.equal(parsed.severity, "sev3");
  });

  it("projects a bounded service label for same-organization automatic service linking", () => {
    const withService = parseAlertmanagerPayload(payload({}, [alert({ labels: { alertname: "CheckoutLatency", service: " checkout ", severity: "warning" } })]), NOW).alerts[0]!;
    assert.equal(withService.serviceName, "checkout");

    const tooLong = parseAlertmanagerPayload(payload({}, [alert({ labels: { alertname: "CheckoutLatency", service: "x".repeat(1_024), severity: "warning" } })]), NOW).alerts[0]!;
    assert.equal(tooLong.serviceName?.length, 100, "service values are bounded before database matching");
  });

  it("orders alerts deterministically and collapses identical entries inside one request", () => {
    const a = alert({ fingerprint: "bbb" });
    const b = alert({ fingerprint: "aaa" });
    const resolvedA = alert({ fingerprint: "aaa", status: "resolved" });
    const { alerts } = parseAlertmanagerPayload(payload({}, [a, resolvedA, b, a]), NOW);
    assert.deepEqual(alerts.map((x) => `${x.fingerprint}:${x.status}`), ["aaa:firing", "aaa:resolved", "bbb:firing"]);
  });

  it("never builds a title/description from labels outside the allow-list", () => {
    const p = payload({}, [alert({ labels: { alertname: "X", secret_label: "do-not-store", severity: "warning" } })]);
    const a = parseAlertmanagerPayload(p, NOW).alerts[0]!;
    assert.ok(!a.description.includes("do-not-store"));
    assert.equal(a.severity, "sev3");
  });

  it("masks credentials and strips control/bidi characters in projected text; bounds lengths by code point", () => {
    const p = payload({}, [
      alert({
        annotations: {
          summary: "login failed\u0000 for‮ user Bearer abcdefghijklmnop",
          description: "password=hunter2 " + "😀".repeat(1500),
        },
      }),
    ]);
    const a = parseAlertmanagerPayload(p, NOW).alerts[0]!;
    assert.ok(!a.title.includes("abcdefghijklmnop"));
    assert.ok(!a.title.includes("\u0000") && !a.title.includes("‮"));
    assert.ok(!a.description.includes("hunter2"));
    assert.ok(Array.from(a.title).length <= 200);
    assert.ok(a.description.length < 3000);
    assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(a.description), "no half surrogate pairs");
    assert.equal(cleanLine(undefined, 10), "");
  });
});

describe("rejected payloads (nothing is projected)", () => {
  const code = (p: unknown) => failure(() => parseAlertmanagerPayload(p, NOW)).code;

  it("rejects non-objects and unsupported versions", () => {
    for (const body of [null, [], "x", 5]) assert.equal(code(body), "VALIDATION_FAILED");
    for (const version of ["3", "5", 4, undefined, "4.0"]) assert.equal(code(payload({ version })), "VALIDATION_FAILED", String(version));
  });

  it("requires a non-empty alerts array and valid statuses", () => {
    assert.equal(code(payload({}, [])), "VALIDATION_FAILED");
    assert.equal(code({ ...payload(), alerts: undefined }), "VALIDATION_FAILED");
    const badTopLevelStatus = failure(() => parseAlertmanagerPayload(payload({ status: "pending" }), NOW));
    assert.equal(badTopLevelStatus.code, "VALIDATION_FAILED");
    assert.ok(hasDetailMessage(badTopLevelStatus, 'must be "firing" or "resolved"'));
    const badAlertStatus = failure(() => parseAlertmanagerPayload(payload({}, [alert({ status: "silenced" })]), NOW));
    assert.equal(badAlertStatus.code, "VALIDATION_FAILED");
    assert.ok(hasDetailMessage(badAlertStatus, 'must be "firing" or "resolved"'));
    const badVersion = failure(() => parseAlertmanagerPayload(payload({ version: "5" }), NOW));
    assert.equal(badVersion.code, "VALIDATION_FAILED");
    assert.ok(hasDetailMessage(badVersion, 'unsupported webhook version: only "4" is supported'));
  });

  it("rejects malformed fingerprints", () => {
    for (const fingerprint of ["", " ", "has space", "semi;colon", "a".repeat(129), "ünïcode", "a/b", 12345, undefined]) {
      assert.equal(code(payload({}, [alert({ fingerprint })])), "VALIDATION_FAILED", String(fingerprint));
    }
  });

  it("rejects malformed, zero, ancient and far-future startsAt; endsAt must also be valid", () => {
    for (const startsAt of ["nope", "2026-10-15", "0001-01-01T00:00:00Z", "1999-12-31T23:59:59Z", "2026-10-17T12:00:01Z", undefined, 1760522400]) {
      assert.equal(code(payload({}, [alert({ startsAt })])), "VALIDATION_FAILED", String(startsAt));
    }
    assert.equal(code(payload({}, [alert({ endsAt: "soon" })])), "VALIDATION_FAILED");
    // within the allowed skew
    assert.equal(parseAlertmanagerPayload(payload({}, [alert({ startsAt: "2026-10-16T11:00:00Z" })]), NOW).alerts.length, 1);
  });

  it("rejects suspicious or oversized labels and annotations", () => {
    const big = (n: number) => "x".repeat(n);
    const bad: Array<Record<string, unknown>> = [
      { labels: { "bad name": "v" } },
      { labels: { "9starts_with_digit": "v" } },
      { labels: { ["a".repeat(129)]: "v" } },
      { labels: { ["__proto__"]: "v" } },
      { labels: JSON.parse('{"__proto__": "v"}') as Record<string, unknown> },
      { labels: { constructor: "v" } },
      { labels: { alertname: big(1025) } },
      { labels: { alertname: 5 } },
      { labels: Array.from({ length: 65 }, (_, i) => [`l${i}`, "v"]).reduce<Record<string, string>>((o, [k, v]) => ({ ...o, [k as string]: v as string }), {}) },
      { labels: ["not", "an", "object"] },
      { labels: null },
      { annotations: { summary: big(4097) } },
      { annotations: { "bad-name": "v" } },
      { generatorURL: big(2049) },
    ];
    for (const over of bad) assert.equal(code(payload({}, [alert(over)])), "VALIDATION_FAILED", JSON.stringify(over).slice(0, 60));
    assert.equal(code(payload({ groupKey: big(2049) })), "VALIDATION_FAILED");
    assert.equal(code(payload({ commonLabels: { "bad name": "v" } })), "VALIDATION_FAILED");
    assert.equal(code(payload({ receiver: big(257) })), "VALIDATION_FAILED");
    assert.equal(code(payload({ externalURL: big(2049) })), "VALIDATION_FAILED");
    assert.equal(code(payload({ truncatedAlerts: -1 })), "VALIDATION_FAILED");
    assert.equal(code(payload({ truncatedAlerts: 1.5 })), "VALIDATION_FAILED");
  });

  it("validation errors list paths but never echo submitted values", () => {
    const e = failure(() => parseAlertmanagerPayload(payload({}, [alert({ labels: { alertname: "x".repeat(2000) + "SECRET-VALUE" } })]), NOW));
    assert.ok(!JSON.stringify(e.details).includes("SECRET-VALUE"));
  });

  it("more than 50 alerts is 413 and is detected before element validation", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ garbage: i }));
    const e = failure(() => parseAlertmanagerPayload(payload({}, many), NOW));
    assert.equal(e.code, "PAYLOAD_TOO_LARGE");
    assert.equal(e.status, 413);
    const fifty = Array.from({ length: 50 }, (_, i) => alert({ fingerprint: `fp${i}` }));
    assert.equal(parseAlertmanagerPayload(payload({}, fifty), NOW).alerts.length, 50);
  });

  it("truncatedAlerts > 0 is a retryable 503 with Retry-After and a remediation message; nothing is processed", () => {
    const e = failure(() => parseAlertmanagerPayload(payload({ truncatedAlerts: 3 }), NOW));
    assert.equal(e.code, "ALERTS_TRUNCATED");
    assert.equal(e.status, 503);
    assert.equal(e.headers?.["Retry-After"], "60");
    assert.match(e.message, /max_alerts/);
    assert.match(e.message, /group_by/);
  });
});
