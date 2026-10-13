import type { Server as HttpServer } from "node:http";
import { REALTIME_PATH } from "@platform/shared";
import { Server } from "socket.io";
import type { RealtimeHub } from "./hub";
import { isRealtimeOriginAllowed } from "./origin";
import type { RealtimeTransport } from "./types";

export interface SocketIoGatewayOptions {
  allowedOrigins: readonly string[];
}

/**
 * Attaches Socket.IO to the API's HTTP server and connects it to the hub. This file is deliberately thin: every
 * decision lives in RealtimeHub, which has no dependency on Socket.IO.
 *
 * Hardening choices:
 *   - WebSocket transport only: no long-polling surface, no sticky sessions needed when the API is scaled out.
 *   - Origin is verified for every handshake (see origin.ts).
 *   - The client bundle is not served, and clients may send at most 1 KiB per message (they send nothing we read).
 *   - No handler exists for any client-to-server event, so a client cannot join a room or pick an organization.
 *   - Connection state recovery is NOT enabled: it would restore a reconnecting client's old rooms without re-deriving
 *     them from its current session. Every reconnect is a fresh handshake followed by a client-side REST resync.
 */
export function attachSocketIo(httpServer: HttpServer, hub: RealtimeHub, options: SocketIoGatewayOptions): RealtimeTransport {
  const io = new Server(httpServer, {
    path: REALTIME_PATH,
    serveClient: false,
    transports: ["websocket"],
    maxHttpBufferSize: 1024,
    allowRequest: (request, callback) => {
      const origin = request.headers.origin;
      callback(null, isRealtimeOriginAllowed(typeof origin === "string" ? origin : undefined, options.allowedOrigins));
    },
  });

  io.use((socket, next) => {
    hub.authenticateHandshake(socket.handshake.headers).then(
      (result) => {
        if (result.ok) {
          socket.data.binding = result.binding;
          next();
          return;
        }
        const error = new Error(result.code) as Error & { data?: unknown };
        error.data = { code: result.code };
        next(error);
      },
      () => {
        const error = new Error("UNAVAILABLE") as Error & { data?: unknown };
        error.data = { code: "UNAVAILABLE" };
        next(error);
      },
    );
  });

  io.on("connection", (socket) => {
    const binding = socket.data.binding;
    if (!binding) {
      socket.disconnect(true);
      return;
    }
    socket.on("disconnect", () => hub.onDisconnect(socket.id));
    void hub.onConnection({
      id: socket.id,
      binding,
      join: (room) => socket.join(room),
      emit: (event, payload) => void socket.emit(event, payload),
      disconnect: () => void socket.disconnect(true),
    });
  });

  return {
    broadcast: (room, event, payload) => void io.to(room).emit(event, payload),
    disconnectAll: () => {
      // Not io.close(): that would also close the HTTP server, which Nest closes itself.
      io.disconnectSockets(true);
      io.engine.close();
    },
  };
}
