/** Name of the session cookie. The `__Host-` prefix makes browsers insist on Secure, Path=/ and no Domain. */
export const sessionCookieName = (secure: boolean): string => (secure ? "__Host-sid" : "sid");

/** Parses a Cookie request header. Malformed pairs are skipped, never thrown on. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    if (!name || name in out) continue; // first occurrence wins
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      // ignore undecodable values
    }
  }
  return out;
}

export interface SessionCookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * HttpOnly (script cannot read it, which limits what an XSS can steal), SameSite=Lax (not sent on cross-site
 * POSTs), Secure in production. Together with the Origin check this is the CSRF defence.
 */
export function sessionCookie(value: string, options: SessionCookieOptions): { name: string; value: string; options: Record<string, unknown> } {
  return {
    name: sessionCookieName(options.secure),
    value,
    options: { httpOnly: true, sameSite: "lax", secure: options.secure, path: "/", maxAge: options.maxAgeSeconds * 1000 },
  };
}

export function clearedSessionCookie(secure: boolean): { name: string; options: Record<string, unknown> } {
  return { name: sessionCookieName(secure), options: { httpOnly: true, sameSite: "lax", secure, path: "/" } };
}
