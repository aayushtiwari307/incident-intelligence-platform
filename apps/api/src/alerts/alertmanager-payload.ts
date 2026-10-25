import { z } from "zod";
import { ALERTMANAGER_MAX_ALERTS_PER_REQUEST, type IncidentSeverity } from "@platform/shared";
import { AppError, validationFailed } from "../common/errors";
import { redactSecrets } from "../config/redact";

/**
 * Validation, normalisation and projection of the standard Alertmanager webhook payload, version "4".
 * Verified against upstream on 2026-10-15 (notify/webhook/webhook.go and template/template.go; see
 * docs/integrations/alertmanager.md): `version`, `groupKey`, `truncatedAlerts`, `status`, `receiver`, `groupLabels`,
 * `commonLabels`, `commonAnnotations`, `routeLabels`, `externalURL`, `notification_reason` and, per alert, `status`,
 * `labels`, `annotations`, `startsAt`, `endsAt`, `generatorURL`, `fingerprint`.
 *
 * Everything in here is pure (no I/O, no database) and treats the body as untrusted:
 *  - every accepted string is bounded, label/annotation names are restricted, unknown fields are dropped;
 *  - nothing outside the small projection built at the bottom is ever persisted (no raw body, no arbitrary labels);
 *  - links such as `generatorURL` / `externalURL` are validated for size only; they are never stored or fetched.
 */

export const MAX_LABELS_PER_MAP = 64;
export const MAX_LABEL_VALUE_LENGTH = 1_024;
export const MAX_ANNOTATION_VALUE_LENGTH = 4_096;
export const MAX_URL_LENGTH = 2_048;
export const MAX_GROUP_KEY_LENGTH = 2_048;
export const MAX_FINGERPRINT_LENGTH = 128;

const FINGERPRINT = /^[A-Za-z0-9._:-]{1,128}$/;
const MAP_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Earliest startsAt accepted. Go's zero time (0001-01-01) means "unset" and is rejected for startsAt. */
const MIN_STARTS_AT_MS = Date.UTC(2000, 0, 1);
/** Allowed clock skew between sender and this server for a startsAt in the future. */
const MAX_FUTURE_SKEW_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------------------------
// RFC 3339 timestamps

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|[+-]\d{2}:\d{2})$/;

/** Date.UTC maps years 0-99 to 1900-1999 (which would turn Go's zero time, year 1, into 1901); setUTCFullYear does not. */
function utcDate(year: number, month: number, day: number, hour: number, minute: number, second: number): Date {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(hour, minute, second, 0);
  return d;
}

export interface NormalizedTimestamp {
  /** Canonical form: UTC, exactly six fractional digits (PostgreSQL's precision; extra digits are truncated, not rounded). */
  iso: string;
  /** Milliseconds since the epoch (sub-millisecond digits dropped); only for range checks. */
  epochMs: number;
}

/**
 * Parses an RFC 3339 timestamp strictly (real calendar date, valid offset, no leap second) and returns its canonical
 * UTC form. Two spellings of the same instant therefore produce the same string, which is what the dedupe key needs.
 * Returns null when the input is not a valid RFC 3339 timestamp.
 */
export function normalizeRfc3339(value: string): NormalizedTimestamp | null {
  const m = RFC3339.exec(value);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number) as [number, number, number, number, number, number];
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  const check = utcDate(year, month, day, 0, 0, 0);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null; // e.g. Feb 30

  let offsetMinutes = 0;
  const zone = m[8] as string;
  if (zone !== "Z" && zone !== "z") {
    const sign = zone.startsWith("-") ? -1 : 1;
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offsetMinutes = sign * (oh * 60 + om);
  }
  const epochMs = utcDate(year, month, day, hour, minute, second).getTime() - offsetMinutes * 60_000;
  const utc = new Date(epochMs);
  if (Number.isNaN(utc.getTime()) || utc.getUTCFullYear() < 1 || utc.getUTCFullYear() > 9999) return null;
  const fraction = (m[7] ?? "").padEnd(9, "0").slice(0, 6);
  return { iso: `${utc.toISOString().slice(0, 19)}.${fraction}Z`, epochMs };
}

const isGoZeroTime = (iso: string): boolean => iso.startsWith("0001-01-01T00:00:00.");

// ---------------------------------------------------------------------------------------------
// Severity

/**
 * `labels.severity` (case-insensitive, trimmed) -> the platform's severity. Missing or unknown values map to the
 * DEFAULT_SEVERITY: an alert must never be lost or mis-created because of an unfamiliar label, and a human re-rates it.
 */
export const SEVERITY_MAP: Readonly<Record<string, IncidentSeverity>> = {
  critical: "sev1", page: "sev1", emergency: "sev1", fatal: "sev1", sev1: "sev1", p1: "sev1",
  error: "sev2", major: "sev2", high: "sev2", sev2: "sev2", p2: "sev2",
  warning: "sev3", warn: "sev3", medium: "sev3", sev3: "sev3", p3: "sev3",
  info: "sev4", informational: "sev4", minor: "sev4", low: "sev4", none: "sev4", debug: "sev4", sev4: "sev4", p4: "sev4",
};
export const DEFAULT_SEVERITY: IncidentSeverity = "sev3";

export function mapSeverity(label: string | undefined): IncidentSeverity {
  if (label === undefined) return DEFAULT_SEVERITY;
  const key = label.trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(SEVERITY_MAP, key) ? (SEVERITY_MAP[key] as IncidentSeverity) : DEFAULT_SEVERITY;
}

// ---------------------------------------------------------------------------------------------
// Schema

type StringMap = Record<string, string>;

/** A string->string map with bounded size, restricted key names and bounded values. Output has a null prototype. */
const stringMap = (maxValueLength: number) =>
  z.unknown().transform((value, ctx): StringMap => {
    const out: StringMap = Object.create(null) as StringMap;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an object of string values" });
      return z.NEVER;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > MAX_LABELS_PER_MAP) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${MAX_LABELS_PER_MAP} entries are allowed` });
      return z.NEVER;
    }
    for (const [key, entry] of entries) {
      if (!MAP_KEY.test(key) || FORBIDDEN_KEYS.has(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key.slice(0, 40)], message: "invalid name (letters, digits and underscore only; at most 128 characters)" });
        continue;
      }
      if (typeof entry !== "string") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "must be a string" });
        continue;
      }
      if (entry.length > maxValueLength) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `must be at most ${maxValueLength} characters` });
        continue;
      }
      out[key] = entry;
    }
    return out;
  });

const timestamp = z.string().max(40).transform((value, ctx): NormalizedTimestamp => {
  const parsed = normalizeRfc3339(value);
  if (!parsed) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an RFC 3339 timestamp, for example 2026-10-15T10:00:00Z" });
    return z.NEVER;
  }
  return parsed;
});

const statusSchema = z.enum(["firing", "resolved"], { errorMap: () => ({ message: 'must be "firing" or "resolved"' }) });
const url = z.string().max(MAX_URL_LENGTH);

const alertSchema = z.object({
  status: statusSchema,
  labels: stringMap(MAX_LABEL_VALUE_LENGTH),
  annotations: stringMap(MAX_ANNOTATION_VALUE_LENGTH).optional(),
  startsAt: timestamp,
  endsAt: timestamp.optional().nullable(),
  generatorURL: url.optional(), // validated for size only; never stored, never fetched
  fingerprint: z.string().regex(FINGERPRINT, `must be 1-${MAX_FINGERPRINT_LENGTH} characters of letters, digits, '.', '_', ':' or '-'`),
});

/** Unknown fields (current and future) are dropped by zod's default "strip" behaviour, so they can never be persisted. */
const payloadSchema = z.object({
  version: z.literal("4", { errorMap: () => ({ message: 'unsupported webhook version: only "4" is supported' }) }),
  groupKey: z.string().max(MAX_GROUP_KEY_LENGTH).optional(),
  truncatedAlerts: z.number().int().min(0).max(1_000_000_000).optional(),
  status: statusSchema,
  receiver: z.string().max(256).optional(), // informational only: NEVER selects a tenant
  groupLabels: stringMap(MAX_LABEL_VALUE_LENGTH).optional(),
  commonLabels: stringMap(MAX_LABEL_VALUE_LENGTH).optional(),
  commonAnnotations: stringMap(MAX_ANNOTATION_VALUE_LENGTH).optional(),
  routeLabels: stringMap(MAX_LABEL_VALUE_LENGTH).optional(),
  externalURL: url.optional(),
  notification_reason: z.string().max(128).optional(),
  alerts: z.array(alertSchema).min(1, "at least one alert is required"),
});

// ---------------------------------------------------------------------------------------------
// Projection (the ONLY data that leaves this module toward storage)

export interface ParsedAlert {
  status: "firing" | "resolved";
  fingerprint: string;
  /** Canonical UTC timestamp with six fractional digits: the dedupe key component. */
  startsAt: string;
  /** Sender's endsAt when meaningful (Go zero time = still firing = null). Informational. */
  endsAt: string | null;
  severity: IncidentSeverity;
  title: string;
  description: string;
  /** Optional service label used only to link the incident to a same-organization catalog entry. */
  serviceName: string | null;
}

export interface ParsedDelivery {
  alerts: ParsedAlert[];
}

/** Label keys copied (value-bounded) into an incident description. Everything else is discarded. */
const DESCRIPTION_LABELS = ["alertname", "severity", "job", "instance", "namespace", "service", "cluster", "env"] as const;

// eslint-disable-next-line no-control-regex -- stripping control, bidi-override and zero-width characters is the purpose
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** Splits by code point so a character is never cut in half. */
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : `${points.slice(0, max - 1).join("")}…`;
}

/** One line of untrusted text: unsafe characters removed, secrets masked, whitespace collapsed, bounded. */
export function cleanLine(value: string | undefined, max: number): string {
  if (!value) return "";
  return truncate(redactSecrets(value.replace(UNSAFE_CHARS, " "), Number.MAX_SAFE_INTEGER), max);
}

function project(alert: z.infer<typeof alertSchema>): ParsedAlert {
  const labels = alert.labels;
  const annotations = alert.annotations ?? (Object.create(null) as StringMap);
  const alertname = cleanLine(labels.alertname, 100);
  const summary = cleanLine(annotations.summary ?? annotations.message, 100);
  const title = truncate(alertname && summary ? `${alertname}: ${summary}` : alertname || summary || "Alertmanager alert", 200);

  const severity = mapSeverity(labels.severity);
  const details = cleanLine(annotations.description, 1_000);
  const shownLabels = DESCRIPTION_LABELS.filter((key) => labels[key] !== undefined && cleanLine(labels[key], 120) !== "")
    .map((key) => `${key}=${cleanLine(labels[key], 120)}`)
    .join(", ");
  const lines = [
    "Created automatically from an Alertmanager notification.",
    ...(summary ? [`Summary: ${summary}`] : []),
    ...(details ? [`Details: ${details}`] : []),
    ...(shownLabels ? [`Labels: ${shownLabels}`] : []),
    `Alert started: ${alert.startsAt.iso}`,
  ];

  const endsAt = alert.endsAt && !isGoZeroTime(alert.endsAt.iso) ? alert.endsAt.iso : null;
  const serviceName = cleanLine(labels.service, 100).trim() || null;
  return { status: alert.status, fingerprint: alert.fingerprint, startsAt: alert.startsAt.iso, endsAt, severity, title, description: lines.join("\n"), serviceName };
}

const statusRank = (s: "firing" | "resolved"): number => (s === "firing" ? 0 : 1);

/**
 * Validates a webhook body and returns the bounded projection, in a deterministic processing order
 * (fingerprint, startsAt, firing before resolved). Identical (fingerprint, startsAt, status) entries inside one
 * request are collapsed.
 *
 * Throws AppError:
 *   400 VALIDATION_FAILED       malformed or unsupported payload (never retried by Alertmanager; fix the sender)
 *   413 PAYLOAD_TOO_LARGE       more than ALERTMANAGER_MAX_ALERTS_PER_REQUEST alerts
 *   503 ALERTS_TRUNCATED        truncatedAlerts > 0: the notification is incomplete; nothing is processed (retryable status)
 */
export function parseAlertmanagerPayload(raw: unknown, now: Date = new Date()): ParsedDelivery {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AppError("VALIDATION_FAILED", "The request body must be a JSON object", { details: [{ path: "", message: "must be an object" }] });
  }
  // Cheap size check first so an enormous array is never validated element by element.
  const alerts = (raw as { alerts?: unknown }).alerts;
  if (Array.isArray(alerts) && alerts.length > ALERTMANAGER_MAX_ALERTS_PER_REQUEST) {
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      `A request may contain at most ${ALERTMANAGER_MAX_ALERTS_PER_REQUEST} alerts (received ${alerts.length}). Make Alertmanager groups smaller with group_by; see docs/integrations/alertmanager.md.`,
      { details: { maxAlerts: ALERTMANAGER_MAX_ALERTS_PER_REQUEST, received: alerts.length } },
    );
  }

  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) throw validationFailed(parsed.error);
  const data = parsed.data;

  const maxStart = now.getTime() + MAX_FUTURE_SKEW_MS;
  const rangeIssues: Array<{ path: string; message: string }> = [];
  data.alerts.forEach((alert, index) => {
    const t = alert.startsAt;
    if (isGoZeroTime(t.iso) || t.epochMs < MIN_STARTS_AT_MS || t.epochMs > maxStart) {
      rangeIssues.push({ path: `alerts.${index}.startsAt`, message: "must be a real start time (between 2000-01-01 and 24 hours from now)" });
    }
  });
  if (rangeIssues.length > 0) throw new AppError("VALIDATION_FAILED", "The request is invalid", { details: rangeIssues });

  if ((data.truncatedAlerts ?? 0) > 0) {
    throw new AppError(
      "ALERTS_TRUNCATED",
      `Alertmanager truncated this notification (truncatedAlerts=${data.truncatedAlerts}) because of max_alerts; processing a partial batch would lose alerts, so nothing was processed. ` +
        "Remove max_alerts (or set it to 0) and keep each group within the per-request alert limit using group_by; see docs/integrations/alertmanager.md.",
      { details: { truncatedAlerts: data.truncatedAlerts, maxAlerts: ALERTMANAGER_MAX_ALERTS_PER_REQUEST }, headers: { "Retry-After": "60" } },
    );
  }

  const seen = new Set<string>();
  const projected: ParsedAlert[] = [];
  for (const alert of data.alerts) {
    const item = project(alert);
    const key = `${item.fingerprint}\u0000${item.startsAt}\u0000${item.status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    projected.push(item);
  }
  projected.sort(
    (a, b) =>
      (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0) ||
      (a.startsAt < b.startsAt ? -1 : a.startsAt > b.startsAt ? 1 : 0) ||
      statusRank(a.status) - statusRank(b.status),
  );
  return { alerts: projected };
}
