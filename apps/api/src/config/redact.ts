// Secret redaction for logs and error messages.
//
// Adapted from the reference project's `sanitizedString` in backend/src/lib/worker.ts (MIT,
// see THIRD_PARTY_NOTICES.md). The reference only covered `sk-` keys, Bearer tokens and
// `api_key=`. This version also covers GitHub tokens, Google API keys, JWTs, `password=` style
// pairs and credentials embedded in URLs.

const MASK = "[REDACTED]";

const TEXT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Credentials embedded in a URL: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, `$1${MASK}@`],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, MASK],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED_JWT]"],
  [/\bBearer\s+\S+/gi, `Bearer ${MASK}`],
  [/\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*\S+/gi, `$1=${MASK}`],
];

export function redactSecrets(text: string, maxLength = 2000): string {
  let result = text;
  for (const [pattern, replacement] of TEXT_PATTERNS) result = result.replace(pattern, replacement);
  return result.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

/** Masks the password of a connection URL, keeping scheme, user, host, port and path. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "REDACTED";
    return parsed.toString();
  } catch {
    return "[unparseable url]";
  }
}

const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|authorization|api[-_]?key|cookie|private|credential|database_?url|redis_?url)/i;

/**
 * Deep-copies `value` for logging: values under sensitive-looking keys are masked and every
 * string goes through `redactSecrets`. Bounded depth keeps cyclic or huge structures safe.
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[max depth]";
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return { name: value.name, message: redactSecrets(value.message) };
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? MASK : redactValue(inner, depth + 1);
  }
  return out;
}
