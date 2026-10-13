import { REALTIME_EVENTS, can, type ResyncReason } from "@platform/shared";
import { parseCookies, sessionCookieName } from "../http/cookies";
import { parseEventNotification, organizationRoom, type EventNotification } from "./notification";
import type { HandshakeResult, RealtimeAuth, RealtimeEventSource, RealtimeSocket, RealtimeTransport } from "./types";

export interface HubLogger {
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface RealtimeHubOptions {
  /** Must match the API's cookie mode: production uses the `__Host-` cookie name. */
  secureCookies: boolean;
  /** Concurrent connections allowed per user (several tabs and devices are normal; unbounded is a resource leak). */
  maxConnectionsPerUser?: number;
  /** Notifications queued for loading before the hub gives up on exactness and asks clients to resync. */
  maxPendingNotifications?: number;
  /** Failed access re-checks in a row before every connection is closed (fail closed, bounded staleness). */
  maxConsecutiveSweepFailures?: number;
  log?: HubLogger;
}

const NOOP_LOG: HubLogger = { warn: () => undefined };

/**
 * The transport-independent core of the real-time layer. It decides who may connect, which room they are in, what is
 * delivered to whom, and when access ends. Socket.IO and PostgreSQL are plugged in from outside, so every rule here is
 * testable without either.
 *
 * Tenant isolation rests on four rules:
 *   1. A connection's organization comes from its authenticated session; no client message can change it.
 *   2. The only room a connection joins is `org:<its organization>`.
 *   3. A pushed message is loaded from the database filtered by the notified organization, and broadcast only to that
 *      organization's room.
 *   4. Access is re-checked continuously: a revoked or expired session, a removed member, or a changed active
 *      organization gets disconnected (immediately on the instance that handled the change, otherwise within one sweep).
 */
export class RealtimeHub {
  private transport: RealtimeTransport | null = null;
  private readonly sockets = new Map<string, RealtimeSocket>();
  private readonly perUser = new Map<string, number>();
  private readonly perOrganization = new Map<string, number>();
  private pending: EventNotification[] = [];
  private pumping: Promise<void> | null = null;
  private sweepChain: Promise<unknown> = Promise.resolve();
  private sweepFailures = 0;
  private sweepTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private readonly maxPerUser: number;
  private readonly maxPending: number;
  private readonly maxSweepFailures: number;
  private readonly log: HubLogger;

  constructor(
    private readonly auth: RealtimeAuth,
    private readonly events: RealtimeEventSource,
    private readonly options: RealtimeHubOptions,
  ) {
    this.maxPerUser = options.maxConnectionsPerUser ?? 10;
    this.maxPending = options.maxPendingNotifications ?? 500;
    this.maxSweepFailures = options.maxConsecutiveSweepFailures ?? 3;
    this.log = options.log ?? NOOP_LOG;
  }

  bindTransport(transport: RealtimeTransport): void {
    this.transport = transport;
  }

  /** Starts the periodic access re-check. Safe to call once; stopped by close(). */
  startSweeper(intervalMs: number): void {
    if (this.sweepTimer || this.closed) return;
    this.sweepTimer = setInterval(() => void this.revalidate(), intervalMs);
    this.sweepTimer.unref();
  }

  stats(): { connections: number; organizations: number; pending: number } {
    return { connections: this.sockets.size, organizations: this.perOrganization.size, pending: this.pending.length };
  }

  // ---- connecting ---------------------------------------------------------------------------------------------

  /** Authenticates a handshake from its cookie. Runs before the connection exists, so a refusal never creates a socket. */
  async authenticateHandshake(headers: Readonly<Record<string, string | string[] | undefined>>): Promise<HandshakeResult> {
    if (this.closed) return { ok: false, code: "UNAVAILABLE" };
    const cookieHeader = Array.isArray(headers.cookie) ? headers.cookie[0] : headers.cookie;
    const token = parseCookies(cookieHeader)[sessionCookieName(this.options.secureCookies)];
    let context;
    try {
      context = await this.auth.authenticate(token);
    } catch (error) {
      this.log.warn("realtime handshake could not be authenticated", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false, code: "UNAVAILABLE" };
    }
    if (!context) return { ok: false, code: "UNAUTHENTICATED" };
    if (!context.organizationId) return { ok: false, code: "NO_ORGANIZATION" };
    if (!can(context.role, "incident:read")) return { ok: false, code: "FORBIDDEN" };
    if ((this.perUser.get(context.userId) ?? 0) >= this.maxPerUser) return { ok: false, code: "TOO_MANY_CONNECTIONS" };
    return { ok: true, binding: { sessionId: context.sessionId, userId: context.userId, organizationId: context.organizationId } };
  }

  /** Called once per accepted connection. Joins the one room the session entitles it to, then tells the client it is live. */
  async onConnection(socket: RealtimeSocket): Promise<void> {
    const { userId, organizationId } = socket.binding;
    // Re-checked here because several handshakes for one user can be in flight at the same time.
    if (this.closed || (this.perUser.get(userId) ?? 0) >= this.maxPerUser) {
      this.safeDisconnect(socket);
      return;
    }
    this.track(socket);
    try {
      await socket.join(organizationRoom(organizationId));
    } catch (error) {
      this.log.warn("realtime room join failed", { error: error instanceof Error ? error.message : String(error) });
      this.untrack(socket.id);
      this.safeDisconnect(socket);
      return;
    }
    if (!this.sockets.has(socket.id)) return; // it disconnected (or was revoked) while joining
    socket.emit(REALTIME_EVENTS.ready, { organizationId });
  }

  onDisconnect(socketId: string): void {
    this.untrack(socketId);
  }

  // ---- delivering ---------------------------------------------------------------------------------------------

  /** Entry point for a raw NOTIFY payload. Never throws. */
  handleNotification(raw: string): void {
    if (this.closed) return;
    const notification = parseEventNotification(raw);
    if (!notification) {
      this.log.warn("realtime notification ignored: malformed payload");
      this.resyncAll("load_failed");
      return;
    }
    if (!this.perOrganization.has(notification.organizationId)) return; // nobody connected here belongs to that organization
    if (this.pending.length >= this.maxPending) {
      this.pending = [];
      this.resyncAll("overflow");
      return;
    }
    this.pending.push(notification);
    this.startPump();
  }

  /** The notification stream was interrupted and restored: anything committed meanwhile was not pushed. */
  handleStreamGap(): void {
    this.resyncAll("stream_gap");
  }

  private startPump(): void {
    if (this.pumping) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = null;
      if (this.pending.length > 0 && !this.closed) this.startPump();
    });
  }

  /** Strictly sequential, so messages leave in commit order (NOTIFY order) and one slow load cannot be overtaken. */
  private async pump(): Promise<void> {
    while (this.pending.length > 0 && !this.closed) {
      const next = this.pending.shift() as EventNotification;
      if (!this.perOrganization.has(next.organizationId)) continue;
      let message;
      try {
        message = await this.events.load(next.organizationId, next.eventId);
      } catch (error) {
        this.log.warn("realtime event could not be loaded", { eventId: next.eventId, error: error instanceof Error ? error.message : String(error) });
        this.resyncOrganization(next.organizationId, "load_failed");
        continue;
      }
      if (!message || message.eventId !== next.eventId) {
        this.log.warn("realtime event missing or mismatched", { eventId: next.eventId });
        this.resyncOrganization(next.organizationId, "load_failed");
        continue;
      }
      this.transport?.broadcast(organizationRoom(next.organizationId), REALTIME_EVENTS.incident, message);
    }
  }

  private resyncOrganization(organizationId: string, reason: ResyncReason): void {
    this.transport?.broadcast(organizationRoom(organizationId), REALTIME_EVENTS.resync, { reason });
  }

  private resyncAll(reason: ResyncReason): void {
    for (const organizationId of this.perOrganization.keys()) this.resyncOrganization(organizationId, reason);
  }

  // ---- ending access ------------------------------------------------------------------------------------------

  /** Re-checks every connection against the database. Calls are serialised; resolves with the number of connections closed. */
  revalidate(): Promise<number> {
    const run = this.sweepChain.then(
      () => this.sweepOnce(),
      () => this.sweepOnce(),
    );
    this.sweepChain = run.catch(() => undefined);
    return run;
  }

  /** Fire-and-forget re-check, called after something that can end access (logout, organization switch, member removal). */
  requestRevalidation(): void {
    void this.revalidate().catch(() => undefined);
  }

  private async sweepOnce(): Promise<number> {
    if (this.closed) return 0;
    // Only connections that existed BEFORE the query are judged by it; a newer one passed its own handshake.
    const snapshot = [...this.sockets.values()];
    if (snapshot.length === 0) {
      this.sweepFailures = 0;
      return 0;
    }
    let live;
    try {
      live = await this.auth.resolveSessions([...new Set(snapshot.map((s) => s.binding.sessionId))]);
      this.sweepFailures = 0;
    } catch (error) {
      this.sweepFailures += 1;
      this.log.warn("realtime access re-check failed", { consecutiveFailures: this.sweepFailures, error: error instanceof Error ? error.message : String(error) });
      if (this.sweepFailures < this.maxSweepFailures) return 0;
      // Cannot confirm anyone's access any longer: fail closed. Clients reconnect and are re-authenticated.
      for (const socket of snapshot) {
        this.untrack(socket.id);
        this.safeDisconnect(socket);
      }
      return snapshot.length;
    }

    let closed = 0;
    for (const socket of snapshot) {
      const { sessionId, userId, organizationId } = socket.binding;
      const state = live.get(sessionId);
      const stillEntitled = state !== undefined && state.userId === userId && state.organizationId === organizationId && can(state.role, "incident:read");
      if (stillEntitled) continue;
      this.untrack(socket.id);
      this.safeDisconnect(socket);
      closed += 1;
    }
    return closed;
  }

  /** Stops timers and closes every connection. */
  close(): void {
    this.closed = true;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.pending = [];
    this.transport?.disconnectAll();
    this.sockets.clear();
    this.perUser.clear();
    this.perOrganization.clear();
  }

  // ---- bookkeeping --------------------------------------------------------------------------------------------

  private track(socket: RealtimeSocket): void {
    this.sockets.set(socket.id, socket);
    const { userId, organizationId } = socket.binding;
    this.perUser.set(userId, (this.perUser.get(userId) ?? 0) + 1);
    this.perOrganization.set(organizationId, (this.perOrganization.get(organizationId) ?? 0) + 1);
  }

  private untrack(socketId: string): void {
    const socket = this.sockets.get(socketId);
    if (!socket) return;
    this.sockets.delete(socketId);
    const { userId, organizationId } = socket.binding;
    this.decrement(this.perUser, userId);
    this.decrement(this.perOrganization, organizationId);
  }

  private decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 0) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  private safeDisconnect(socket: RealtimeSocket): void {
    try {
      socket.disconnect();
    } catch (error) {
      this.log.warn("realtime disconnect failed", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
