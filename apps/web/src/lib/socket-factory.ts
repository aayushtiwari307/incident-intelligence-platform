import { REALTIME_PATH } from "@platform/shared";
import { io } from "socket.io-client";
import type { SocketLike } from "./realtime-client";

/**
 * The only place that touches socket.io-client. WebSocket transport only (matching the server), credentials included
 * so the HttpOnly session cookie authenticates the handshake: the page never sees or sends a token itself.
 */
export function createSocket(apiUrl: string): SocketLike {
  const socket = io(apiUrl, {
    path: REALTIME_PATH,
    transports: ["websocket"],
    withCredentials: true,
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 15000,
    randomizationFactor: 0.5,
  });
  return {
    on: (event, listener) => socket.on(event, listener),
    connect: () => socket.connect(),
    close: () => socket.close(),
  };
}
