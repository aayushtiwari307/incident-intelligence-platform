import type { IncidentRealtimeMessage } from "@platform/shared";
import type { AuthContext, SessionState } from "../auth/auth.service";

export type { SessionState };

/** What a connection is bound to. Set by the server during the handshake; a client can never change it. */
export interface SocketBinding {
  sessionId: string;
  userId: string;
  organizationId: string;
}

/** The slice of AuthService the real-time layer needs. */
export interface RealtimeAuth {
  authenticate(token: string | undefined): Promise<AuthContext | null>;
  /** Live state of the given sessions; sessions that are revoked, expired, unknown or of a disabled user are absent. */
  resolveSessions(sessionIds: readonly string[]): Promise<Map<string, SessionState>>;
}

/** Loads the message for one committed timeline entry. Null when it cannot be delivered (for example, it vanished). */
export interface RealtimeEventSource {
  load(organizationId: string, eventId: number): Promise<IncidentRealtimeMessage | null>;
}

/** One connected client, as the hub sees it. The Socket.IO adapter implements this; tests use a fake. */
export interface RealtimeSocket {
  readonly id: string;
  readonly binding: SocketBinding;
  /** Subscribes the connection to a room. Rooms are chosen by the hub only, never by client messages. */
  join(room: string): void | Promise<void>;
  emit(event: string, payload: unknown): void;
  disconnect(): void;
}

/** Fan-out and shutdown, implemented by the Socket.IO adapter. */
export interface RealtimeTransport {
  broadcast(room: string, event: string, payload: unknown): void;
  disconnectAll(): void;
}

export type HandshakeResult =
  | { ok: true; binding: SocketBinding }
  | { ok: false; code: "UNAUTHENTICATED" | "NO_ORGANIZATION" | "FORBIDDEN" | "TOO_MANY_CONNECTIONS" | "UNAVAILABLE" };
