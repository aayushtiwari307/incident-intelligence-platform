/** Name of the PostgreSQL NOTIFY channel written by the trigger in migration 0006. */
export const INCIDENT_EVENTS_CHANNEL = "incident_events";

export interface EventNotification {
  eventId: number;
  organizationId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses the trigger's payload `{"id": <bigint>, "o": "<uuid>"}`. Anything else returns null: the payload crosses a
 * process boundary and is used to build a room name, so it is validated rather than trusted.
 */
export function parseEventNotification(raw: string): EventNotification | null {
  if (raw.length > 200) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const { id, o } = value as { id?: unknown; o?: unknown };
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) return null;
  if (typeof o !== "string" || !UUID.test(o)) return null;
  return { eventId: id, organizationId: o.toLowerCase() };
}

/** The only room name format. It is built from a validated, database-loaded organization id, never from client input. */
export const organizationRoom = (organizationId: string): string => `org:${organizationId}`;
