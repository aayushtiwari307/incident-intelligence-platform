"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { can } from "@platform/shared";
import { ROLE_LABEL } from "../lib/format";
import { api, useSession } from "../lib/session";

/**
 * Wraps pages that need a signed-in user. This is a convenience (redirect, hide controls): every API call is
 * authenticated and authorised again on the server, so removing this component would not expose any data.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, logout, setMe } = useSession();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (state.status === "anonymous") router.replace("/login");
  }, [state.status, router]);

  if (state.status === "loading") return <p role="status" className="page-status">Loading…</p>;
  if (state.status === "error") {
    return (
      <p role="alert" className="page-status">
        {state.message}
      </p>
    );
  }
  if (state.status === "anonymous") return <p role="status" className="page-status">Redirecting to sign in…</p>;

  const { me } = state;
  const link = (href: string, label: string) => (
    <Link href={href} aria-current={pathname === href || pathname.startsWith(`${href}/`) ? "page" : undefined}>
      {label}
    </Link>
  );

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <strong className="brand">Incident platform</strong>
        <nav aria-label="Main">
          {link("/incidents", "Incidents")}
          {link("/services", "Services")}
          {link("/github", "GitHub") }
          {link("/team", "Team")}
        </nav>
        <div className="topbar-right">
          {me.memberships.length > 1 ? (
            <label className="org-switch">
              <span className="visually-hidden">Organization</span>
              <select
                value={me.activeOrganizationId ?? ""}
                onChange={async (e) => {
                  setMe(await api.switchOrganization(e.target.value));
                  router.push("/incidents");
                }}
              >
                {me.memberships.map((m) => (
                  <option key={m.organizationId} value={m.organizationId}>
                    {m.organizationName}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span>{me.memberships[0]?.organizationName}</span>
          )}
          <span className="role-chip" title="Your role in this organization">
            {me.role ? ROLE_LABEL[me.role] : "No role"}
          </span>
          <span className="muted">{me.user.displayName}</span>
          <button type="button" className="btn-link" onClick={() => void logout().then(() => router.replace("/login"))}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" tabIndex={-1} className="container">
        {me.role ? children : <p role="alert">You are not a member of any organization yet. Ask an admin for an invitation.</p>}
      </main>
    </>
  );
}

export function useCan(action: Parameters<typeof can>[1]): boolean {
  const { state } = useSession();
  return state.status === "authenticated" && can(state.me.role, action);
}
