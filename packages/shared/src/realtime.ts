import type { IncidentDto, IncidentEventDto } from "./incident";

// ---------------------------------------------------------------------------------------------
// Real-time protocol (Socket.IO). One contract shared by the API gateway and the web client.
//
// There is deliberately NO client-to-server message that selects an organization or an incident: the room a
// connection is in is derived by the server from the authenticated session, so a client cannot ask for data
// it is not entitled to. The server only ever pushes.

/** Socket.IO engine path. Both sides must agree on it. */
export const REALTIME_PATH = "/socket.io";

/** Server -> client event names. */
export const REALTIME_EVENTS = {
  /** The connection is authenticated and subscribed. The client should (re)load its REST state now. */
  ready: "realtime.ready",
  /** One audited incident change (the append-only timeline entry plus the incident's state at delivery time). */
  incident: "incident.event",
  /** The server cannot guarantee it delivered everything: the client must reload its REST state. */
  resync: "realtime.resync",
} as const;

/** Why a handshake was refused. Carried in the Socket.IO `connect_error` data as `{ code }`. */
export const REALTIME_REJECTION_CODES = ["UNAUTHENTICATED", "NO_ORGANIZATION", "FORBIDDEN", "TOO_MANY_CONNECTIONS", "UNAVAILABLE"] as const;
export type RealtimeRejectionCode = (typeof REALTIME_REJECTION_CODES)[number];

/** Rejections that retrying cannot fix: the client must refresh its session instead of reconnecting. */
export const REALTIME_FATAL_REJECTIONS: readonly RealtimeRejectionCode[] = ["UNAUTHENTICATED", "NO_ORGANIZATION", "FORBIDDEN"];

export interface RealtimeReadyMessage {
  organizationId: string;
}

export interface IncidentRealtimeMessage {
  /** `incident_events.id`: unique and increasing, so clients can drop duplicates. */
  eventId: number;
  incidentId: string;
  event: IncidentEventDto;
  /**
   * The incident as stored when the message was prepared. It can be NEWER than `event` (several changes in quick
   * succession); clients keep whichever snapshot has the higher `version`.
   */
  incident: IncidentDto;
}

export const RESYNC_REASONS = ["stream_gap", "overflow", "load_failed"] as const;
export type ResyncReason = (typeof RESYNC_REASONS)[number];

export interface ResyncMessage {
  reason: ResyncReason;
}
