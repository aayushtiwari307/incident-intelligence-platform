/**
 * Outbound redaction: runs on every piece of text BEFORE it is sent to an AI provider.
 *
 * BEST EFFORT, not a guarantee. It removes well-known secret shapes (emails, bearer tokens, API-key formats, JWTs,
 * `password=` pairs, credentials inside connection strings, private-key blocks). A secret in a format this list does
 * not know, or one split across words, is NOT caught. The other defences are that only a minimal context is sent
 * (title, description, resolution text), that AI is opt-in per organization, and that a human reviews every suggestion.
 *
 * Pure and deterministic: the same input always gives the same output. It never logs, and callers must log COUNTS only.
 * This is separate from config/redact.ts, which sanitises log lines and is tuned for that job.
 */

export const REDACTION_KINDS = ["private_key", "connection_string", "jwt", "bearer_token", "api_key", "password_pair", "email"] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];
export type RedactionCounts = Record<RedactionKind, number>;

export interface RedactionResult {
  text: string;
  counts: RedactionCounts;
}

/** Anything beyond this is dropped before matching (inputs are already bounded far below it; this bounds regex work). */
const MAX_INPUT_CHARS = 100_000;

const emptyCounts = (): RedactionCounts => ({ private_key: 0, connection_string: 0, jwt: 0, bearer_token: 0, api_key: 0, password_pair: 0, email: 0 });

type Replacer = string | ((match: string, ...groups: string[]) => string);

interface Rule {
  kind: RedactionKind;
  pattern: RegExp;
  replace: Replacer;
}

/** Keys whose value is a secret when written `key=value`, `key: value` or `"key": "value"`. */
const SECRET_KEY =
  "(?:pass(?:word|wd)?|pwd|passphrase|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|private[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token)";

/**
 * Order matters: the most specific, longest-spanning shapes first, so a connection string is removed whole before the
 * email rule can see the `user@host` inside it, and a JWT is removed before the generic `token=` rule.
 * Every quantifier is bounded or applied to a simple character class, so matching stays linear on adversarial input.
 */
const RULES: readonly Rule[] = [
  // PEM private keys, complete block.
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,20000}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
    replace: "[REDACTED_PRIVATE_KEY]",
  },
  // A BEGIN line whose END is missing (truncated paste): everything after it is treated as key material.
  { kind: "private_key", pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g, replace: "[REDACTED_PRIVATE_KEY]" },
  // scheme://user:password@host/...  (also redis://:password@host and mongodb+srv://...). The whole URL goes.
  {
    kind: "connection_string",
    pattern: /\b[a-z][a-z0-9+.-]{1,30}:\/\/[^\s:/@]*:[^\s@/]+@[^\s'"<>)]+/gi,
    replace: "[REDACTED_CONNECTION_STRING]",
  },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{0,}/g, replace: "[REDACTED_JWT]" },
  // An Authorization header value (any scheme), then a bare "Bearer <token>". "Basic" and "Token" are everyday words, so
  // they are only treated as schemes inside an Authorization header; a bare bearer token must be long enough that
  // ordinary prose ("bearer authentication") is left alone.
  {
    kind: "bearer_token",
    pattern: /\b(authorization\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (_m, header) => `${header}[REDACTED_TOKEN]`,
  },
  { kind: "bearer_token", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: "Bearer [REDACTED_TOKEN]" },
  // Vendor key formats. Each is anchored on a distinctive prefix to limit false positives.
  { kind: "api_key", pattern: /\bsk-(?:proj-|live-|test-)?[A-Za-z0-9_-]{8,}/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\bglpat-[A-Za-z0-9_-]{16,}/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\bAIza[0-9A-Za-z_-]{20,}/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: "[REDACTED_API_KEY]" },
  { kind: "api_key", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g, replace: "[REDACTED_API_KEY]" },
  // key=value / key: value / "key": "value": keep the key, drop the value. A quoted value may contain spaces.
  {
    kind: "password_pair",
    pattern: new RegExp(`((?<![A-Za-z0-9])${SECRET_KEY}\\b["']?\\s*[:=]\\s*)(?:"[^"\\n]{0,500}"|'[^'\\n]{0,500}'|[^\\s"',;&)]{1,500})`, "gi"),
    replace: (_m, prefix) => `${prefix}[REDACTED]`,
  },
  { kind: "email", pattern: /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}/g, replace: "[REDACTED_EMAIL]" },
];

export function redactForProvider(input: string): RedactionResult {
  const counts = emptyCounts();
  let text = input.length > MAX_INPUT_CHARS ? input.slice(0, MAX_INPUT_CHARS) : input;
  for (const rule of RULES) {
    text = text.replace(rule.pattern, (...args: unknown[]) => {
      counts[rule.kind] += 1;
      const match = args[0] as string;
      return typeof rule.replace === "string" ? rule.replace : rule.replace(match, ...(args.slice(1, -2) as string[]));
    });
  }
  return { text, counts };
}

export function addCounts(a: RedactionCounts, b: RedactionCounts): RedactionCounts {
  const out = emptyCounts();
  for (const kind of REDACTION_KINDS) out[kind] = a[kind] + b[kind];
  return out;
}

export const zeroCounts = emptyCounts;

export function totalRedactions(counts: RedactionCounts): number {
  return REDACTION_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
}
