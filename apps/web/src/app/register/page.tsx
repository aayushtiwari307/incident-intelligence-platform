"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
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

  const inviteRegistration = Boolean(inviteToken);

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
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length > 0) setFields(e.fieldErrors);
      else setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <main className="auth-card">
      <h1>{inviteRegistration ? "Join your teammate’s organization" : "Create your organization"}</h1>
      <p className="muted">
        {inviteRegistration
          ? "Create your account using the invited email. Your account will join the organization directly; no separate organization will be created."
          : "You become the owner of your new organization. If a colleague invited you, open their invitation link to register directly into their organization. Existing accounts can sign in and accept an invitation under Team."}
      </p>
      <form onSubmit={submit} noValidate>
        <FormError message={error} />
        <Field label="Your name" htmlFor="displayName" error={fields.displayName}>
          <input id="displayName" name="displayName" autoComplete="name" required aria-describedby={fields.displayName ? "displayName-error" : undefined} />
        </Field>
        {!inviteRegistration ? (
          <Field label="Organization name" htmlFor="organizationName" error={fields.organizationName}>
            <input id="organizationName" name="organizationName" autoComplete="organization" required />
          </Field>
        ) : null}
        <Field label="Email" htmlFor="email" error={fields.email}>
          <input id="email" name="email" type="email" autoComplete="username" required />
        </Field>
        <Field label="Password (12+ characters)" htmlFor="password" error={fields.password}>
          <input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
        </Field>
        <button type="submit" className="btn" disabled={busy || !inviteChecked}>
          {busy ? "Creating…" : inviteRegistration ? "Join organization" : "Create account"}
        </button>
      </form>
      <p>
        Already registered?{" "}
        <Link href={inviteRegistration && inviteToken ? `/login#invite=${encodeURIComponent(inviteToken)}` : "/login"}>
          Sign in
        </Link>
        {inviteRegistration ? " to accept this invitation." : null}
      </p>
    </main>
  );
}
