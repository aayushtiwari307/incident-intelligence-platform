import {
  REALTIME_EVENTS,
  REALTIME_FATAL_REJECTIONS,
  RESYNC_REASONS,
  type IncidentRealtimeMessage,
  type ResyncReason,
} from "@platform/shared";

export type RealtimeStatus = "connecting" | "live" | "reconnecting" | "offline";

/** The slice of a Socket.IO client socket this module uses (so tests need no real socket). */
export interface SocketLike {
  on(event: string, listener: (payload: unknown) => void): unknown;
  connect(): unknown;
  close(): unknown;
}

export interface RealtimeHandlers {
  onStatus(status: RealtimeStatus): void;
  onEvent(message: IncidentRealtimeMessage): void;
  /** Reload state over the REST API: the subscription just became live, or the server says pushes may have been missed. */
  onSync(reason: "ready" | ResyncReason): void;
  /** The server ended or refused access for good. Refresh the session; do not hammer the server by reconnecting. */
  onAccessLost(): void;
}

export interface RealtimeOptions {
  createSocket(): SocketLike;
  handlers: RealtimeHandlers;
  /** Delays between manual retries after a refusal that Socket.IO does not retry by itself. Last value repeats. */
  retryDelaysMs?: readonly number[];
}

export function startRestFallback(
  handlers: Pick<RealtimeHandlers, "onStatus" | "onSync">,
  intervalMs = 30_000,
): { stop(): void } {
  handlers.onStatus("offline");
  handlers.onSync("ready");
  const timer = setInterval(() => handlers.onSync("stream_gap"), intervalMs);
  return { stop: () => clearInterval(timer) };
}

export function isIncidentMessage(value: unknown): value is IncidentRealtimeMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  const event = v.event as Record<string, unknown> | null | undefined;
  const incident = v.incident as Record<string, unknown> | null | undefined;
  return (
    typeof v.eventId === "number" &&
    typeof v.incidentId === "string" &&
    typeof event === "object" && event !== null && typeof event.id === "number" && typeof event.type === "string" &&
    typeof incident === "object" && incident !== null && typeof incident.id === "string" && typeof incident.version === "number"
  );
}

const rejectionCode = (error: unknown): string | undefined => {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  return typeof data?.code === "string" ? data.code : undefined;
};

/**
 * Drives one live connection. The server never asks the client to do anything but reload: all state still comes from
 * the authenticated REST API, and pushes only make it current sooner.
 *
 * Reconnection: transport failures are retried by Socket.IO itself. A refusal by the server's handshake check is not,
 * so non-fatal ones (too many connections, temporarily unavailable) are retried here with a growing delay, while fatal
 * ones (not signed in, no organization, no permission) stop and ask the app to refresh the session.
 */
export function startRealtime(options: RealtimeOptions): { stop(): void } {
  const { handlers } = options;
  const delays = options.retryDelaysMs && options.retryDelaysMs.length > 0 ? options.retryDelaysMs : [2000, 5000, 15000, 30000];
  const socket = options.createSocket();
  let stopped = false;
  let retries = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const live = (fn: () => void) => () => {
    if (!stopped) fn();
  };
  const retryLater = (): void => {
    if (stopped || timer) return;
    const delay = delays[Math.min(retries, delays.length - 1)] as number;
    retries += 1;
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) socket.connect();
    }, delay);
  };

  handlers.onStatus("connecting");

  socket.on("connect", live(() => handlers.onStatus("connecting")));

  socket.on(
    REALTIME_EVENTS.ready,
    live(() => {
      retries = 0;
      handlers.onStatus("live");
      handlers.onSync("ready");
    }),
  );

  socket.on(
    REALTIME_EVENTS.incident,
    (payload) => {
      if (!stopped && isIncidentMessage(payload)) handlers.onEvent(payload);
    },
  );

  socket.on(REALTIME_EVENTS.resync, (payload) => {
    if (stopped) return;
    const reason = (payload as { reason?: unknown } | null)?.reason;
    handlers.onSync(RESYNC_REASONS.find((r) => r === reason) ?? "stream_gap");
  });

  socket.on("disconnect", (reason) => {
    if (stopped) return;
    if (reason === "io server disconnect") {
      // The server cut this connection (logout, removal, organization change, shutdown); Socket.IO will not retry.
      handlers.onStatus("offline");
      handlers.onAccessLost();
      return;
    }
    handlers.onStatus("reconnecting"); // transport problems: Socket.IO reconnects with its own backoff
  });

  socket.on("connect_error", (error) => {
    if (stopped) return;
    const code = rejectionCode(error);
    if (code === undefined) {
      handlers.onStatus("reconnecting"); // lower-level failure: Socket.IO keeps retrying
      return;
    }
    if ((REALTIME_FATAL_REJECTIONS as readonly string[]).includes(code)) {
      stopped = true;
      if (timer) clearTimeout(timer);
      socket.close();
      handlers.onStatus("offline");
      handlers.onAccessLost();
      return;
    }
    handlers.onStatus("reconnecting");
    retryLater();
  });

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      socket.close();
    },
  };
}
