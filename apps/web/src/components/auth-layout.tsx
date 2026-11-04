import type { ReactNode } from "react";
import { LogoMark } from "./icons";

/** Focused sign-in and registration layout for the IIP workspace. */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main className="auth auth-centered">
      <div className="auth-shell">
        <header className="auth-brand-header">
          <div className="brand auth-brand-mark">
            <LogoMark large />
            <span>IIP Console</span>
          </div>
          <p>Incident Intelligence Platform</p>
        </header>
        <section className="auth-form" aria-label="Account access">
          <div className="auth-form-inner">{children}</div>
        </section>
        <footer className="auth-foot">Private workspaces for incident response teams.</footer>
      </div>
    </main>
  );
}
