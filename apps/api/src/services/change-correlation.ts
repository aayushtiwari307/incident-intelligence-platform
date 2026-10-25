/**
 * Strict timestamp and correlation semantics for M10.
 *
 * Webhook timestamps must be actual RFC 3339 instants with an explicit offset. Date.parse alone normalizes some
 * impossible dates (for example September 31), so calendar fields are checked before parsing. The service remains
 * tenant-scoped in SQL; these helpers validate only temporal semantics and never replace database authorization.
 */
export const CHANGE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const CHANGE_MAX_FUTURE_MS = 5 * 60 * 1000;
export const CHANGE_CORRELATION_WINDOW_HOURS = 24;
export const MAX_CHANGE_CONTEXT_ITEMS = 20;
export const CHANGE_CORRELATION_LABEL = "correlation, not proven cause" as const;

const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Returns a Date only for a real RFC 3339 instant within the accepted age/clock-skew window. */
export function parseChangeTimestamp(value: unknown, now: Date): Date | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const match = RFC3339.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const zoneHour = match[10] === undefined ? 0 : Number(match[10]);
  const zoneMinute = match[11] === undefined ? 0 : Number(match[11]);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  if (zoneHour > 23 || zoneMinute > 59) return null;
  // RFC 3339 uses -00:00 to mean the local offset is unknown, not known UTC. We need a known instant to correlate.
  if (match[9] === "-" && zoneHour === 0 && zoneMinute === 0) return null;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]!) return null;

  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return null;
  const current = now.getTime();
  if (!Number.isFinite(current)) return null;
  const age = current - epoch;
  if (age > CHANGE_MAX_AGE_MS || age < -CHANGE_MAX_FUTURE_MS) return null;
  return new Date(epoch);
}

/** SQL uses the same inclusive interval: a change between incident start minus 24h and incident start. */
export function isWithinIncidentChangeWindow(changeAt: Date, incidentStartedAt: Date, windowHours = CHANGE_CORRELATION_WINDOW_HOURS): boolean {
  if (!Number.isFinite(changeAt.getTime()) || !Number.isFinite(incidentStartedAt.getTime())) return false;
  if (!Number.isInteger(windowHours) || windowHours < 1 || windowHours > 72) return false;
  const difference = incidentStartedAt.getTime() - changeAt.getTime();
  return difference >= 0 && difference <= windowHours * 60 * 60 * 1000;
}
