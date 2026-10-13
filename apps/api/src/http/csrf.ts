const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface OriginCheckInput {
  method: string;
  /** Value of the Origin request header, if any. */
  origin: string | undefined;
  allowedOrigins: readonly string[];
}

/**
 * Cross-site request forgery needs a victim's BROWSER to send a state-changing request with the victim's cookie.
 * Browsers always attach an Origin header to cross-origin POST/PUT/PATCH/DELETE requests, so:
 *   - unsafe method + Origin present  -> the origin must be on our allow-list (otherwise reject)
 *   - unsafe method + no Origin       -> not a browser cross-origin request (curl, server-to-server, same-origin
 *                                        navigation quirks), so it cannot be CSRF; allow
 *   - safe method                     -> never changes state, allow
 * `Origin: null` (sandboxed iframes, some redirects) is never on the allow-list and is rejected.
 */
export function isOriginAllowed({ method, origin, allowedOrigins }: OriginCheckInput): boolean {
  if (SAFE_METHODS.has(method.toUpperCase())) return true;
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin);
}
