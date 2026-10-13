import { MigrationError } from "./types";

const isIdentChar = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_$\u0080-￿]/.test(c);
const isTagStart = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_\u0080-￿]/.test(c);

function unterminated(what: string): MigrationError {
  return new MigrationError("INVALID_CONTENT", `SQL contains an unterminated ${what}`);
}

/**
 * Splits a SQL script into its top-level statements, the way the server's lexer would.
 *
 * Semicolons only separate statements when they are outside of:
 *   - line comments (-- ...) and nested block comments
 *   - single-quoted strings ('' escapes; backslash escapes only in E'...')
 *   - double-quoted identifiers
 *   - dollar-quoted bodies ($$ ... $$ and $tag$ ... $tag$)
 *
 * The returned text has comments replaced by a space (so the first keyword is easy to read) and is
 * otherwise unchanged. Statements that contain no code are dropped. Throws INVALID_CONTENT for an
 * unterminated quote or comment, because the real parser would refuse that file too.
 *
 * Deliberately not supported: `BEGIN ATOMIC ... END` function bodies (they contain top-level
 * semicolons); callers reject them separately.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let hasCode = false;
  let i = 0;
  const n = sql.length;

  const push = () => {
    if (hasCode) statements.push(current.trim());
    current = "";
    hasCode = false;
  };

  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];

    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      current += " ";
      continue;
    }

    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else {
          i++;
        }
      }
      if (depth > 0) throw unterminated("block comment");
      current += " ";
      continue;
    }

    if (c === "'") {
      // E'...' strings treat backslash as an escape; a preceding identifier char other than E/e means it is not a prefix.
      const prev = sql[i - 1];
      const escapeString = (prev === "E" || prev === "e") && !isIdentChar(sql[i - 2]);
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (escapeString && sql[i] === "\\") {
          i += 2;
        } else if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          closed = true;
          break;
        } else {
          i++;
        }
      }
      if (!closed) throw unterminated("string literal");
      current += sql.slice(start, i);
      hasCode = true;
      continue;
    }

    if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') {
          i += 2;
        } else if (sql[i] === '"') {
          i++;
          closed = true;
          break;
        } else {
          i++;
        }
      }
      if (!closed) throw unterminated("quoted identifier");
      current += sql.slice(start, i);
      hasCode = true;
      continue;
    }

    if (c === "$" && !isIdentChar(sql[i - 1])) {
      // $$ or $tag$ opens a dollar-quoted body. $1 (a parameter) and foo$bar (an identifier) do not.
      let j = i + 1;
      if (isTagStart(sql[j])) {
        while (j < n && isIdentChar(sql[j]) && sql[j] !== "$") j++;
      }
      if (sql[j] === "$") {
        const tag = sql.slice(i, j + 1);
        const end = sql.indexOf(tag, j + 1);
        if (end === -1) throw unterminated(`dollar-quoted string (${tag})`);
        current += sql.slice(i, end + tag.length);
        i = end + tag.length;
        hasCode = true;
        continue;
      }
    }

    if (c === ";") {
      push();
      i++;
      continue;
    }

    current += c;
    if (!/\s/.test(c)) hasCode = true;
    i++;
  }
  push();
  return statements;
}
