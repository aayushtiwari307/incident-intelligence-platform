/**
 * Origin policy for the WebSocket handshake.
 *
 * Browsers do not apply CORS to WebSockets, so a page on ANY origin could open one and (for same-site origins, such
 * as another port on the same host) the browser would attach the session cookie: cross-site WebSocket hijacking.
 * Therefore the Origin header is checked against the same allow-list as state-changing HTTP requests.
 *
 *   - Origin present  -> must be on the allow-list (`Origin: null` never is)
 *   - Origin absent   -> not a browser (browsers always send it on a WebSocket handshake); a non-browser client still
 *                        has to present a valid session cookie, which an attacker's web page cannot obtain
 */
export function isRealtimeOriginAllowed(origin: string | undefined, allowedOrigins: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowedOrigins.includes(origin);
}
