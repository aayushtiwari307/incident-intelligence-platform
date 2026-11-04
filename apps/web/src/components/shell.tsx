"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { can } from "@platform/shared";
import { ROLE_LABEL, initials } from "../lib/format";
import { api, useSession } from "../lib/session";
import { CommandPalette } from "./command-palette";
import { Icon, LogoMark, type IconName } from "./icons";

const NAV: Array<{ href: string; label: string; icon: IconName }> = [
  { href: "/incidents", label: "Incidents", icon: "incidents" },
  { href: "/services", label: "Services", icon: "services" },
  { href: "/github", label: "GitHub", icon: "github" },
  { href: "/team", label: "Team", icon: "team" },
];

/**
 * Wraps pages that need a signed-in user. This is a convenience (redirect, hide controls): every API call is
 * authenticated and authorised again on the server, so removing this component would not expose any data.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { state, logout, setMe } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const signedIn = state.status === "authenticated";

  useEffect(() => {
    if (state.status === "anonymous") router.replace("/login");
  }, [state.status, router]);

  // Ctrl K (or Cmd K) opens the "jump to" palette from anywhere in the signed-in app.
  useEffect(() => {
    if (!signedIn) return;
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [signedIn]);

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
  const activeOrg = me.memberships.find((m) => m.organizationId === me.activeOrganizationId) ?? me.memberships[0];

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <aside className="sidebar">
        <Link href="/incidents" className="brand">
          <LogoMark />
          IIP Console
        </Link>
        <button type="button" className="search-btn" onClick={() => setPaletteOpen(true)} aria-keyshortcuts="Control+K" aria-label="Search and jump to, Control K">
          <span>
            <Icon name="search" size={15} stroke={2} />
            Search
          </span>
          <span className="kbd" aria-hidden="true">
            Ctrl K
          </span>
        </button>
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
        ) : null}
        <nav aria-label="Main">
          {NAV.map((item) => {
            const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link key={item.href} href={item.href} className="nav-link" aria-current={current ? "page" : undefined}>
                <Icon name={item.icon} />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="user-card">
          <span className="avatar-lg" aria-hidden="true">
            {initials(me.user.displayName).slice(0, 1)}
            <span className="presence" />
          </span>
          <div className="who" title="Your role in this organization">
            <strong>{me.user.displayName}</strong>
            <span>
              {activeOrg?.organizationName ?? "No organization"} · {me.role ? ROLE_LABEL[me.role] : "No role"}
            </span>
          </div>
          <button type="button" className="icon-btn" aria-label="Sign out" title="Sign out" onClick={() => void logout().then(() => router.replace("/login"))}>
            <Icon name="signout" size={16} />
          </button>
        </div>
      </aside>
      <div className="main-wrap">
        <main id="main" tabIndex={-1} className="container">
          {me.role ? children : <p role="alert">You are not a member of any organization yet. Ask an admin for an invitation.</p>}
        </main>
      </div>
      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}

export function useCan(action: Parameters<typeof can>[1]): boolean {
  const { state } = useSession();
  return state.status === "authenticated" && can(state.me.role, action);
}
