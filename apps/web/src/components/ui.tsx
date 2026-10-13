import type { IncidentSeverity, IncidentStatus } from "@platform/shared";
import type { ReactNode } from "react";
import { SEVERITY_LABEL, STATUS_LABEL } from "../lib/format";

export const SeverityBadge = ({ severity }: { severity: IncidentSeverity }) => (
  <span className={`badge sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>
);

export const StatusBadge = ({ status }: { status: IncidentStatus }) => <span className={`badge st-${status}`}>{STATUS_LABEL[status]}</span>;

/** Error text announced to screen readers; renders nothing when there is no message. */
export function FormError({ message }: { message: string | null }) {
  return (
    <div role="alert" className="form-error">
      {message}
    </div>
  );
}

export function Field({ label, error, children, htmlFor }: { label: string; error?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

const LIVE_LABEL = { live: "Live", connecting: "Connecting…", reconnecting: "Reconnecting…" } as const;

/** Shows whether pushed updates are flowing. Hidden when offline; the page still works through ordinary requests. */
export function LiveStatus({ status }: { status: "connecting" | "live" | "reconnecting" | "offline" }) {
  if (status === "offline") return null;
  return (
    <span className={`live live-${status}`} role="status" aria-live="polite" title="Live updates">
      <span aria-hidden="true">●</span> {LIVE_LABEL[status]}
    </span>
  );
}
