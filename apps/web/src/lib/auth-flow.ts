import type { MeDto } from "@platform/shared";
import { ApiError } from "./api-client";

export type SessionVerification = { ok: true; me: MeDto } | { ok: false; message: string };

/**
 * Shown when sign-in succeeded on the server but the browser did not send a working session cookie back. The usual
 * causes are a `Secure`/`__Host-` cookie dropped over plain http on a non-localhost host, or a web app and API that
 * are not on the same site (SameSite=Lax cookies are not sent on cross-site requests).
 */
export const SESSION_NOT_ESTABLISHED =
  "Signed in, but your browser did not keep the session. Open the app at the exact address your administrator gave you " +
  "(over https, or http://127.0.0.1 for local use) and check that the web app and API share one site. Then try again.";

/** The session cookie is HttpOnly, so script cannot look at it; the only honest check is to use it. */
export const SESSION_MISMATCH =
  "Signed in, but the browser is still using a different session. Sign out, clear this site's cookies and try again.";

/**
 * A successful login/registration response only proves the SERVER created a session. Before the UI treats the user as
 * signed in, confirm that this browser actually presents a working session by calling /api/auth/me, and that it is the
 * session of the account that just signed in (not a stale cookie for another account).
 *
 * `loadMe` is injected so this stays free of browser APIs and is unit-testable. It never throws.
 */
export async function verifySession(loadMe: () => Promise<MeDto>, expectedUserId: string): Promise<SessionVerification> {
  let me: MeDto;
  try {
    me = await loadMe();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { ok: false, message: SESSION_NOT_ESTABLISHED };
    const detail = error instanceof ApiError ? error.message : "unexpected error";
    return { ok: false, message: `Signed in, but the session could not be confirmed (${detail}). Please try again.` };
  }
  if (me.user.id !== expectedUserId) return { ok: false, message: SESSION_MISMATCH };
  return { ok: true, me };
}
