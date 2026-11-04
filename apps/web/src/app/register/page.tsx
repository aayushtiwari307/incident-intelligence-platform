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

export default function RegisterPage() {
  const router = useRouter();
  const { setMe } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteChecked, setInviteChecked] = useState(false);
  // Asked of the API (the single source of truth) instead of guessed from the build mode. `null` until answered.
  const [publicRegistration, setPublicRegistration] = useState<boolean | null>(null);

  useEffect(() => {
    // Invitation credentials live in the URL fragment, which browsers do not send in HTTP requests or referrers.
    const token = new URLSearchParams(window.location.hash.slice(1)).get("invite");
    if (token) {
      setInviteToken(token);
      // Remove the bearer token from the address bar after capturing it in component state.
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    } else {
      setInviteToken("");
    }
    setInviteChecked(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.registrationPolicy().then(
      (policy) => {
        if (!cancelled) setPublicRegistration(policy.publicRegistration);
      },
      () => {
        // The policy is only a UI hint. If it cannot be read, show the form: the server still enforces the policy, and a
        // refusal is turned into the invitation-only message below.
        if (!cancelled) setPublicRegistration(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const inviteRegistration = Boolean(inviteToken);
  const policyChecked = publicRegistration !== null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    setFields({});
    try {
      const credentials = {
        email: String(form.get("email")),
        password: String(form.get("password")),
        displayName: String(form.get("displayName")),
      };
      const registered =
        inviteRegistration && inviteToken
          ? await api.registerWithInvite({ ...credentials, inviteToken })
          : await api.register({ ...credentials, organizationName: String(form.get("organizationName")) });
      // The server created the account and a session; confirm this browser really holds it before showing signed-in UI.
      const verified = await verifySession(api.me, registered.user.id);
      if (!verified.ok) {
        setError(verified.message);
        setBusy(false);
        return;
      }
      setMe(verified.me);
      router.replace("/incidents");
    } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.code === "FORBIDDEN" && !inviteRegistration) {
        // The server refused public sign-up (the policy request may have failed earlier): show the same message as the policy does.
        setPublicRegistration(false);
      } else if (e instanceof ApiError && Object.keys(e.fieldErrors).length > 0) setFields(e.fieldErrors);
      else setError(errorText(e));
      setBusy(false);
    }
  }

  // Wait for both answers so a form is never shown and then replaced by the invitation-only message.
  if (!inviteChecked || (!inviteRegistration && !policyChecked)) {
    return (
      <AuthLayout>
        <p className="muted" role="status">
          Loading…
        </p>
      </AuthLayout>
    );
  }
  if (!inviteRegistration && publicRegistration === false) {
    return (
      <AuthLayout>
        <h1>Registration is by invitation only</h1>
        <p className="sub">
          This workspace is invitation-only. Ask an organization owner to invite your email address.
        </p>
        <div className="aside-box auth-footer-link" style={{ marginTop: 0 }}>
          <strong>Already registered?</strong> <Link href="/login">Sign in</Link>
        </div>
      </AuthLayout>
    );
  }
  return (
    <AuthLayout>
      <h1>{inviteRegistration ? "Join your teammate’s organization" : "Create your organization"}</h1>
      <p className="sub">
        {inviteRegistration
          ? "Use your invited email to join your teammate’s workspace."
          : "Set up a private workspace for your team. You’ll become its owner."}
      </p>
      <form onSubmit={submit} noValidate>
        <FormError message={error} />
        <Field label="Your name" htmlFor="displayName" error={fields.displayName}>
          <input id="displayName" name="displayName" autoComplete="name" required autoFocus placeholder="Ada Lovelace" aria-describedby={fields.displayName ? "displayName-error" : undefined} />
        </Field>
        {!inviteRegistration ? (
          <Field label="Organization name" htmlFor="organizationName" error={fields.organizationName}>
            <input id="organizationName" name="organizationName" autoComplete="organization" required placeholder="Your team or company" />
          </Field>
        ) : null}
        <Field label="Email" htmlFor="email" error={fields.email}>
          <input id="email" name="email" type="email" autoComplete="username" required placeholder="you@company.com" />
        </Field>
        <Field label="Password (12+ characters)" htmlFor="password" error={fields.password}>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required placeholder="At least 12 characters" />
        </Field>
        <button type="submit" className="btn block" disabled={busy}>
          {busy ? "Creating…" : inviteRegistration ? "Join organization" : "Create account"}
        </button>
      </form>
      <div className="aside-box auth-footer-link">
        <strong>Already registered?</strong>{" "}
        <Link href={inviteRegistration && inviteToken ? `/login#invite=${encodeURIComponent(inviteToken)}` : "/login"}>
          Sign in
        </Link>
        {inviteRegistration ? " to accept this invitation." : null}
      </div>
    </AuthLayout>
  );
}
