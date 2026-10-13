/** One live LISTEN session on its own database connection (a pooled connection would drop subscriptions when recycled). */
export interface ListenConnection {
  onNotification(callback: (payload: string) => void): void;
  /** Fires once when the connection is lost or fails its heartbeat. */
  onClose(callback: (error?: Error) => void): void;
  close(): Promise<void>;
}

/** Opens a connection AND issues LISTEN; resolves only when notifications are actually flowing. */
export type ConnectListen = () => Promise<ListenConnection>;

export interface NotificationListenerOptions {
  minBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface NotificationHandlers {
  onNotification(payload: string): void;
  /** The stream was interrupted and has been restored (or the first connection took retries): pushes may have been missed. */
  onGap(): void;
}

/**
 * Keeps one LISTEN connection alive. On loss it reconnects with exponential backoff and, once notifications flow
 * again, reports a gap so the hub can tell clients to resync. It never throws into the caller: the API keeps serving
 * REST traffic while the stream is down.
 */
export class NotificationListener {
  private connection: ListenConnection | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private attempts = 0;
  private everConnected = false;
  private readonly minBackoff: number;
  private readonly maxBackoff: number;

  constructor(
    private readonly connect: ConnectListen,
    private readonly handlers: NotificationHandlers,
    private readonly options: NotificationListenerOptions = {},
  ) {
    this.minBackoff = options.minBackoffMs ?? 500;
    this.maxBackoff = options.maxBackoffMs ?? 15_000;
  }

  get connected(): boolean {
    return this.connection !== null;
  }

  /** Makes the first attempt and resolves when it has finished (successfully or not). */
  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    await this.attempt();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const connection = this.connection;
    this.connection = null;
    await connection?.close().catch(() => undefined);
  }

  private async attempt(): Promise<void> {
    if (this.stopped) return;
    this.timer = null;
    let connection: ListenConnection;
    try {
      connection = await this.connect();
    } catch (error) {
      this.attempts += 1;
      this.options.log?.("realtime listener could not connect", { attempt: this.attempts, error: error instanceof Error ? error.message : String(error) });
      this.scheduleRetry();
      return;
    }
    if (this.stopped) {
      await connection.close().catch(() => undefined);
      return;
    }
    // Pushes could have been missed if this is not the very first, immediately successful connection.
    const gap = this.everConnected || this.attempts > 0;
    this.everConnected = true;
    this.attempts = 0;
    this.connection = connection;
    connection.onNotification((payload) => this.handlers.onNotification(payload));
    connection.onClose((error) => {
      if (this.connection !== connection) return; // a stale connection
      this.connection = null;
      this.options.log?.("realtime listener connection lost", error ? { error: error.message } : undefined);
      if (!this.stopped) {
        void connection.close().catch(() => undefined);
        this.scheduleRetry();
      }
    });
    if (gap) this.handlers.onGap();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(this.maxBackoff, this.minBackoff * 2 ** Math.min(this.attempts, 10));
    this.timer = setTimeout(() => void this.attempt(), delay);
    this.timer.unref();
  }
}
