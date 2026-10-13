import { Client } from "pg";
import type { ConnectListen } from "./listener";
import { INCIDENT_EVENTS_CHANNEL } from "./notification";

const HEARTBEAT_MS = 30_000;

/** The real connection: a dedicated `pg` Client running `LISTEN incident_events`. */
export function createPgListenConnector(databaseUrl: string, connectTimeoutMs: number): ConnectListen {
  return async () => {
    const client = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: connectTimeoutMs, keepAlive: true });
    let notify: (payload: string) => void = () => undefined;
    let closeCallback: (error?: Error) => void = () => undefined;
    let closed = false;
    let heartbeat: NodeJS.Timeout | null = null;

    const fireClose = (error?: Error): void => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      closeCallback(error);
    };

    client.on("notification", (message) => {
      if (message.channel === INCIDENT_EVENTS_CHANNEL && typeof message.payload === "string") notify(message.payload);
    });
    client.on("error", (error: Error) => fireClose(error));
    client.on("end", () => fireClose());

    await client.connect();
    try {
      await client.query(`LISTEN ${INCIDENT_EVENTS_CHANNEL}`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    // A silently dead TCP connection raises no event; a failing query does.
    heartbeat = setInterval(() => {
      client.query("SELECT 1").catch((error: Error) => fireClose(error));
    }, HEARTBEAT_MS);
    heartbeat.unref();

    return {
      onNotification: (callback) => {
        notify = callback;
      },
      onClose: (callback) => {
        closeCallback = callback;
        if (closed) callback();
      },
      close: async () => {
        closed = true;
        if (heartbeat) clearInterval(heartbeat);
        await client.end();
      },
    };
  };
}
