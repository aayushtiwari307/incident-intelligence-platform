import type { IncidentDto, IncidentEventDto, IncidentSeverity, IncidentStatus } from "@platform/shared";

/**
 * Pure state transitions for live updates. They never regress what the screen already shows: pushes can arrive in
 * any interleaving with REST responses, so every rule is "newest version wins" or "union by id".
 */

/** Keeps whichever snapshot of an incident has the higher version (equal versions take the incoming one). */
export function acceptSnapshot(current: IncidentDto | null, incoming: IncidentDto): IncidentDto {
  if (!current || current.id !== incoming.id) return incoming;
  return incoming.version >= current.version ? incoming : current;
}

/** Union of timeline entries by id, oldest first. Re-delivered or re-fetched entries replace themselves, never duplicate. */
export function mergeTimeline(current: readonly IncidentEventDto[], incoming: readonly IncidentEventDto[]): IncidentEventDto[] {
  const byId = new Map<number, IncidentEventDto>();
  for (const event of current) byId.set(event.id, event);
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

export interface ListFilters {
  status?: IncidentStatus | "";
  severity?: IncidentSeverity | "";
  assignee?: "" | "me" | "unassigned";
}

/** Whether an incident belongs in the list for the current filters (the same rules the server applies). */
export function matchesFilters(incident: IncidentDto, filters: ListFilters, currentUserId: string): boolean {
  if (filters.status && incident.status !== filters.status) return false;
  if (filters.severity && incident.severity !== filters.severity) return false;
  if (filters.assignee === "me" && incident.assignee?.id !== currentUserId) return false;
  if (filters.assignee === "unassigned" && incident.assignee !== null) return false;
  return true;
}

/**
 * Applies one pushed incident snapshot to a list that is sorted newest (highest number) first and may be only
 * partly loaded (`hasMore`).
 *   - already listed: replace it (or drop it if it no longer matches the filters); never with an older version
 *   - not listed and matching: insert it in order, but only inside the loaded range; beyond it, "Load more" finds it
 */
export function reconcileList(items: IncidentDto[], hasMore: boolean, incident: IncidentDto, matches: boolean): IncidentDto[] {
  const index = items.findIndex((item) => item.id === incident.id);
  if (index >= 0) {
    const existing = items[index] as IncidentDto;
    if (incident.version < existing.version) return items;
    if (!matches) return items.filter((_, i) => i !== index);
    const next = [...items];
    next[index] = incident;
    return next;
  }
  if (!matches) return items;
  const lowestLoaded = items.length > 0 ? (items[items.length - 1] as IncidentDto).number : 0;
  if (hasMore && incident.number <= lowestLoaded) return items;
  const position = items.findIndex((item) => item.number < incident.number);
  const next = [...items];
  next.splice(position === -1 ? next.length : position, 0, incident);
  return next;
}
