/**
 * Hygiene for text that came from GitHub (titles, labels, logins, excerpts). It is DATA, never instructions: it is
 * stripped of control and bidirectional-override characters, whitespace-collapsed and length-limited before it is cached
 * or returned, and the web UI renders it as escaped React text only. This is not a substitute for escaping on render.
 */

// C0/C1 controls, bidi embeddings/overrides/isolates, zero-width and line/paragraph separators.
// eslint-disable-next-line no-control-regex -- stripping control, bidi and zero-width characters is the purpose of this pattern
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export function sanitizeRemoteText(value: unknown, maxChars: number): string {
  if (typeof value !== "string" || !Number.isInteger(maxChars) || maxChars < 1) return "";
  const cleaned = value.replace(UNSAFE, " ").replace(/\s+/g, " ").trim();
  // Truncate by code point so a surrogate pair is never split.
  const points = Array.from(cleaned);
  return points.length <= maxChars ? cleaned : points.slice(0, maxChars).join("").trimEnd();
}

/** At most `maxItems` sanitized, non-empty, de-duplicated strings, each at most `maxChars` long. */
export function sanitizeRemoteList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value) || !Number.isInteger(maxItems) || maxItems < 1 || !Number.isInteger(maxChars) || maxChars < 1) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = sanitizeRemoteText(typeof item === "string" ? item : (item as { name?: unknown } | null)?.name, maxChars);
    if (text !== "" && !out.includes(text)) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}


const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?([Zz]|([+-])(\d{2}):(\d{2}))$/;

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** Validates an actual RFC 3339 calendar/time value before normalizing it; Date.parse alone can normalize invalid days. */
export function normalizeRemoteTimestamp(value: unknown): string | null {
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
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || zoneHour > 23 || zoneMinute > 59) return null;
  const days = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > days[month - 1]!) return null;
  if (match[9] === "-" && zoneHour === 0 && zoneMinute === 0) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? new Date(epoch).toISOString() : null;
}
