import type { IncidentDto, IncidentRealtimeMessage, OrgRole } from "@platform/shared";
import type { AuthContext } from "../auth/auth.service";
import type { RealtimeAuth, RealtimeEventSource, RealtimeSocket, RealtimeTransport, SessionState, SocketBinding } from "../realtime/types";

/** Test doubles shared by the real-time unit tests (no database, no sockets). */

export const ORG_A = "11111111-1111-4111-8111-111111111111";
export const ORG_B = "22222222-2222-4222-8222-222222222222";

export class FakeAuth implements RealtimeAuth {
  /** token -> context, for handshakes */
  readonly tokens = new Map<string, AuthContext>();
  /** sessionId -> live state, for sweeps; absent = revoked/expired */
  readonly sessions = new Map<string, SessionState>();
  failResolve: Error | null = null;
  failAuthenticate: Error | null = null;
  resolveCalls = 0;
  /** Awaited inside resolveSessions, to hold a sweep open in tests. */
  resolveGate: Promise<void> | null = null;

  addSession(token: string, init: { sessionId: string; userId: string; organizationId: string | null; role: OrgRole | null }): void {
    this.tokens.set(token, { ...init, email: `${init.userId}@example.com`, displayName: init.userId });
    this.sessions.set(init.sessionId, { ...init });
  }

  async authenticate(token: string | undefined): Promise<AuthContext | null> {
    if (this.failAuthenticate) throw this.failAuthenticate;
    return token ? (this.tokens.get(token) ?? null) : null;
  }

  async resolveSessions(ids: readonly string[]): Promise<Map<string, SessionState>> {
    this.resolveCalls += 1;
    if (this.resolveGate) await this.resolveGate;
    if (this.failResolve) throw this.failResolve;
    const out = new Map<string, SessionState>();
    for (const id of ids) {
      const state = this.sessions.get(id);
      if (state) out.set(id, state);
    }
    return out;
  }
}

export class FakeSocket implements RealtimeSocket {
  readonly rooms: string[] = [];
  readonly emitted: Array<{ event: string; payload: unknown }> = [];
  disconnected = false;
  joinError: Error | null = null;

  constructor(
    readonly id: string,
    readonly binding: SocketBinding,
  ) {}

  join(room: string): void {
    if (this.joinError) throw this.joinError;
    this.rooms.push(room);
  }
  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

export class FakeTransport implements RealtimeTransport {
  readonly sent: Array<{ room: string; event: string; payload: unknown }> = [];
  allDisconnected = false;
  broadcast(room: string, event: string, payload: unknown): void {
    this.sent.push({ room, event, payload });
  }
  disconnectAll(): void {
    this.allDisconnected = true;
  }
}

export const incidentDto = (overrides: Partial<IncidentDto> = {}): IncidentDto => ({
  id: "33333333-3333-4333-8333-333333333333",
  number: 1,
  title: "t",
  description: "",
  severity: "sev3",
  status: "triggered",
  assignee: null,
  createdBy: null,
  version: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  acknowledgedAt: null,
  mitigatedAt: null,
  resolvedAt: null,
  ...overrides,
});

export const messageFor = (eventId: number): IncidentRealtimeMessage => ({
  eventId,
  incidentId: "33333333-3333-4333-8333-333333333333",
  event: { id: eventId, type: "comment", actor: { id: null, label: "a" }, payload: { body: "x" }, createdAt: "2026-01-01T00:00:00.000Z" },
  incident: incidentDto(),
});

export class FakeEvents implements RealtimeEventSource {
  readonly loads: Array<{ organizationId: string; eventId: number }> = [];
  /** eventId -> promise to await before answering (to make one load slower than the next) */
  readonly gates = new Map<number, Promise<void>>();
  readonly failures = new Set<number>();
  readonly missing = new Set<number>();

  async load(organizationId: string, eventId: number): Promise<IncidentRealtimeMessage | null> {
    this.loads.push({ organizationId, eventId });
    const gate = this.gates.get(eventId);
    if (gate) await gate;
    if (this.failures.has(eventId)) throw new Error("db down");
    if (this.missing.has(eventId)) return null;
    return messageFor(eventId);
  }
}

export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export const notification = (id: number, organizationId: string): string => JSON.stringify({ id, o: organizationId });
