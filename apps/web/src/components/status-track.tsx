import { INCIDENT_STATUSES, type IncidentDto, type IncidentEventDto, type IncidentStatus } from "@platform/shared";
import { STATUS_LABEL, relativeTime } from "../lib/format";
import { Icon } from "./icons";

type StepState = "done" | "current" | "skipped" | "future";

/**
 * Pure: decides what each step of the progress track shows. A step before the current status that was never entered is
 * "skipped" (shown dashed): the track never pretends a stage happened when the history says it did not.
 */
export function trackSteps(incident: Pick<IncidentDto, "status" | "createdAt" | "acknowledgedAt" | "mitigatedAt" | "resolvedAt" | "updatedAt">, events: IncidentEventDto[]) {
  const reached = new Map<IncidentStatus, string>();
  reached.set("triggered", incident.createdAt);
  for (const event of events) {
    if (event.type !== "status_changed") continue;
    const to = event.payload.to;
    if (typeof to !== "string" || !(INCIDENT_STATUSES as readonly string[]).includes(to)) continue;
    const status = to as IncidentStatus;
    const previous = reached.get(status);
    if (!previous || event.createdAt > previous) reached.set(status, event.createdAt);
  }
  const fallbacks: Array<[IncidentStatus, string | null]> = [
    ["acknowledged", incident.acknowledgedAt],
    ["mitigated", incident.mitigatedAt],
    ["resolved", incident.resolvedAt],
  ];
  for (const [status, at] of fallbacks) if (at && !reached.has(status)) reached.set(status, at);

  const currentIndex = INCIDENT_STATUSES.indexOf(incident.status);
  return INCIDENT_STATUSES.map((status, index) => {
    const state: StepState = index === currentIndex ? "current" : index > currentIndex ? "future" : reached.has(status) ? "done" : "skipped";
    const at = reached.get(status) ?? (state === "current" ? incident.updatedAt : null);
    return { status, state, at };
  });
}

/** Horizontal progress track for an incident's lifecycle. */
export function StatusTrack({ incident, events }: { incident: IncidentDto; events: IncidentEventDto[] }) {
  const steps = trackSteps(incident, events);
  const last = steps.length - 1;
  return (
    <ol className="track" aria-label="Incident progress">
      {steps.map((step, index) => {
        const isFinal = index === last;
        const time = step.state === "skipped" ? "skipped" : step.state === "future" ? "not yet" : step.at ? relativeTime(step.at) : "";
        return (
          <li key={step.status} className={`${step.state}${isFinal ? " final" : ""}`} aria-current={step.state === "current" ? "step" : undefined}>
            <div className="node-row">
              <span className="node">{step.state === "done" || (step.state === "current" && isFinal) ? <Icon name="check" size={11} stroke={4} /> : null}</span>
              {isFinal ? null : <span className="rail" />}
            </div>
            <div className="step-name">{STATUS_LABEL[step.status]}</div>
            <div className="step-time" title={step.at ?? undefined}>
              {time}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
