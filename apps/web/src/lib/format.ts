import type { IncidentEventDto, IncidentSeverity, IncidentStatus, OrgRole } from "@platform/shared";

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  triggered: "Triggered",
  acknowledged: "Acknowledged",
  investigating: "Investigating",
  mitigated: "Mitigated",
  resolved: "Resolved",
};

export const SEVERITY_LABEL: Record<IncidentSeverity, string> = {
  sev1: "SEV1 · Critical",
  sev2: "SEV2 · Major",
  sev3: "SEV3 · Minor",
  sev4: "SEV4 · Low",
};

export const ROLE_LABEL: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", responder: "Responder", viewer: "Viewer" };

export const TRANSITION_VERB: Record<IncidentStatus, string> = {
  triggered: "Reopen as triggered",
  acknowledged: "Acknowledge",
  investigating: "Start investigating",
  mitigated: "Mark mitigated",
  resolved: "Resolve",
};

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago", then a date. `now` is injectable for tests. */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "unknown";
  const seconds = Math.round((now.getTime() - then.getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units: Array<[number, string]> = [
    [60 * 60, "minute"],
    [60 * 60 * 24, "hour"],
    [60 * 60 * 24 * 7, "day"],
  ];
  const divisors = [60, 3600, 86400];
  for (let i = 0; i < units.length; i++) {
    const [limit, unit] = units[i] as [number, string];
    if (seconds < limit) {
      const n = Math.max(1, Math.round(seconds / (divisors[i] as number)));
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
    }
  }
  return then.toISOString().slice(0, 10);
}

/** One readable sentence per timeline event. Text only: React escapes it, nothing is ever injected as HTML. */
export function describeEvent(event: IncidentEventDto): string {
  const p = event.payload as Record<string, unknown>;
  const name = (v: unknown): string => (v && typeof v === "object" && "displayName" in v ? String((v as { displayName: unknown }).displayName) : "nobody");
  switch (event.type) {
    case "created":
      return `opened the incident as ${String(p.severity ?? "").toUpperCase()}`;
    case "status_changed":
      return `changed status from ${String(p.from)} to ${String(p.to)}`;
    case "assigned":
      if (p.reason === "member_removed") return `unassigned ${name(p.from)} because they were removed from the organization`;
      return p.to ? `assigned the incident to ${name(p.to)}` : "removed the assignee";
    case "severity_changed":
      return `changed severity from ${String(p.from).toUpperCase()} to ${String(p.to).toUpperCase()}`;
    case "edited":
      return p.field === "title" ? `renamed the incident to “${String(p.to)}”` : `edited the ${String(p.field)}`;
    case "comment":
      return "commented";
  }
}

/** Short user-facing text for an API failure, never the raw status line. */
export function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return "Something went wrong. Please try again.";
}
