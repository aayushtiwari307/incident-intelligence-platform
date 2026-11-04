import type { IncidentSeverity, IncidentStatus } from "@platform/shared";
import type { ReactNode } from "react";
import { SEVERITY_LABEL, STATUS_LABEL, initials } from "../lib/format";
import { Icon, type IconName } from "./icons";

export const SeverityBadge = ({ severity }: { severity: IncidentSeverity }) => (
  <span className={`chip sev-${severity}`}>{SEVERITY_LABEL[severity]}</span>
);

export const StatusBadge = ({ status }: { status: IncidentStatus }) => (
  <span className={`chip st-${status}`}>
    <span className="dot" aria-hidden="true" />
    {STATUS_LABEL[status]}
  </span>
);

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
      <span className="dot" aria-hidden="true" /> {LIVE_LABEL[status]}
    </span>
  );
}

/** Round avatar with initials, or a dashed "?" for nobody. */
export function Avatar({ name }: { name: string | null | undefined }) {
  if (!name) {
    return (
      <span className="avatar empty" title="Unassigned" role="img" aria-label="Unassigned">
        ?
      </span>
    );
  }
  return (
    <span className="avatar" title={name} role="img" aria-label={name}>
      {initials(name)}
    </span>
  );
}

/** Instructive empty state: says what will appear here and why. */
export function EmptyState({ icon = "inbox", title, children, action, center = false }: { icon?: IconName; title: string; children?: ReactNode; action?: ReactNode; center?: boolean }) {
  return (
    <div className={`empty-state${center ? " center" : ""}`} role="status">
      <span className="ico">
        <Icon name={icon} size={18} stroke={1.8} />
      </span>
      <div>
        <strong>{title}</strong>
        {children ? <p>{children}</p> : null}
        {action}
      </div>
    </div>
  );
}

/** Page title block: title, one plain sentence, and optional actions on the right. */
export function PageHeader({ title, children, actions }: { title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {children ? <p className="page-sub">{children}</p> : null}
      </div>
      {actions ? <div className="page-head-actions">{actions}</div> : null}
    </div>
  );
}

/** Loading placeholder rows for list-shaped content. */
export function SkeletonRows({ rows = 4, label = "Loading…" }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton-row" key={i} aria-hidden="true">
          <span className="skeleton" style={{ width: 54, height: 12 }} />
          <span className="skeleton" style={{ flex: 1, height: 14, maxWidth: 360 }} />
          <span className="skeleton" style={{ width: 84, height: 20, borderRadius: 999 }} />
        </div>
      ))}
    </div>
  );
}
