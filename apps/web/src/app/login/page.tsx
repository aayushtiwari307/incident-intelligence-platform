"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { AuthLayout } from "../../components/auth-layout";
import { Field, FormError } from "../../components/ui";
import { ApiError } from "../../lib/api-client";
import { verifySession } from "../../lib/auth-flow";
import { errorText } from "../../lib/format";
import { api, useSession } from "../../lib/session";

export default function LoginPage() {
  const router = useRouter();
  const { setMe } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [inviteChecked, setInviteChecked] = useState(false);
  const [acceptFailed, setAcceptFailed] = useState(false);
  // Asked of the API, like the register page: only claim "by invitation" when the server really refuses public sign-up.
  const [publicRegistration, setPublicRegistration] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.registrationPolicy().then(
      (policy) => {
        if (!cancelled) setPublicRegistration(policy.publicRegistration);
      },
      () => undefined, // unknown: show the neutral wording below
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("invite");
    if (token) {
      setInviteToken(token);
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    setInviteChecked(true);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const loggedIn = await api.login({ email: String(form.get("email")), password: String(form.get("password")) });
      // The server accepted the credentials; that does not prove this browser holds a working session cookie.
      const verified = await verifySession(api.me, loggedIn.user.id);
      if (!verified.ok) {
        setError(verified.message);
        setBusy(false);
        return;
      }
      if (inviteToken) {
        // When an existing account follows an invitation link, accept it only after successful login.
        try {
          setMe(await api.acceptInvite(inviteToken));
        } catch {
          // Keep the successful login session even when the invite has expired or belongs to another email.
          setMe(verified.me);
          setInviteToken("");
          setAcceptFailed(true);
          setBusy(false);
          return;
        }
      } else {
        setMe(verified.me);
      }
      router.replace("/incidents");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 429 ? "Too many attempts. Wait a few minutes and try again." : errorText(e));
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <h1>Welcome back</h1>
      <p className="sub">Sign in to your workspace.</p>
      {inviteToken ? <p className="notice">After sign-in, we’ll accept the invitation for this account.</p> : null}
      {acceptFailed ? (
        <p role="alert" className="form-error">
          You are signed in, but the invitation could not be accepted (wrong account, expired, revoked or already used). Ask the inviter for a new link.{" "}
          <Link href="/incidents">Continue to incidents</Link>
        </p>
      ) : null}
      <form onSubmit={submit} noValidate>
        <FormError message={error} />
        <Field label="Email" htmlFor="email">
          <input id="email" name="email" type="email" autoComplete="username" required autoFocus placeholder="you@company.com" />
        </Field>
        <Field label="Password" htmlFor="password">
          <input id="password" name="password" type="password" autoComplete="current-password" required placeholder="Your password" />
        </Field>
        <button type="submit" className="btn block" disabled={busy || !inviteChecked}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      <div className="aside-box auth-footer-link">
        <strong>New to IIP?</strong>{" "}
        {publicRegistration === true ? (
          <>
            You can <Link href="/register">create an organization</Link>, or open an invitation link from a teammate to join theirs.
          </>
        ) : (
          <>
            {publicRegistration === false ? "Registration is by invitation only. " : ""}
            Ask a workspace owner for an invite link, then open it to accept your invitation.
            {publicRegistration === null ? (
              <>
                {" "}
                Starting your own workspace? <Link href="/register">Create an organization</Link>.
              </>
            ) : null}
          </>
        )}
      </div>
    </AuthLayout>
  );
}
