import type { Server as HttpServer } from "node:http";
import { Inject, Injectable, type BeforeApplicationShutdown, type OnApplicationBootstrap } from "@nestjs/common";
import { createLogger } from "../common/logger";
import { APP_CONFIG } from "../config/config.module";
import type { AppConfig } from "../config/env";
import { RealtimeHub } from "./hub";
import { NotificationListener, type ConnectListen } from "./listener";
import { createPgListenConnector } from "./pg-listen";
import { attachSocketIo } from "./socketio-gateway";

/** Overridable in tests (to inject a fake LISTEN connection); production uses the real pg connector. */
export const REALTIME_LISTEN_CONNECTOR = Symbol("REALTIME_LISTEN_CONNECTOR");

/**
 * Owns the lifecycle of real-time delivery inside the API process: attach Socket.IO to the HTTP server, keep the
 * PostgreSQL LISTEN connection alive, sweep access periodically, and shut everything down before the HTTP server and
 * the database pool close.
 */
@Injectable()
export class RealtimeService implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log;
  private attached = false;
  private listener: NotificationListener | null = null;

  constructor(
    @Inject(RealtimeHub) private readonly hub: RealtimeHub,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(REALTIME_LISTEN_CONNECTOR) private readonly connector: ConnectListen,
  ) {
    this.log = createLogger(config.logLevel);
  }

  /** Called from configureHttpApplication (shared by main.ts and the E2E tests) so there is one wiring path. */
  attach(server: HttpServer): void {
    if (!this.config.realtime.enabled || this.attached) return;
    this.hub.bindTransport(attachSocketIo(server, this.hub, { allowedOrigins: this.config.http.corsOrigins }));
    this.attached = true;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.attached) {
      this.log.info("real-time updates not started", { reason: this.config.realtime.enabled ? "not attached" : "REALTIME_ENABLED is false" });
      return;
    }
    this.hub.startSweeper(this.config.realtime.revalidateSeconds * 1000);
    this.listener = new NotificationListener(
      this.connector,
      { onNotification: (payload) => this.hub.handleNotification(payload), onGap: () => this.hub.handleStreamGap() },
      { log: (message, fields) => this.log.warn(message, fields) },
    );
    await this.listener.start();
    this.log.info("real-time updates started", { listening: this.listener.connected, revalidateSeconds: this.config.realtime.revalidateSeconds });
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.hub.close();
    await this.listener?.stop();
  }
}

export const defaultListenConnector = (config: AppConfig): ConnectListen =>
  createPgListenConnector(config.database.url.reveal(), config.database.connectTimeoutMs);
