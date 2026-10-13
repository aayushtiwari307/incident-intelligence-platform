"use client";

import { useEffect, useRef, useState } from "react";
import type { IncidentRealtimeMessage, ResyncReason } from "@platform/shared";
import { startRealtime, type RealtimeStatus } from "./realtime-client";
import { API_URL, useSession } from "./session";
import { createSocket } from "./socket-factory";

export interface RealtimeSubscriber {
  onEvent(message: IncidentRealtimeMessage): void;
  /** Reload your REST state. Called when the subscription becomes live (including after every reconnect) and on server resync requests. */
  onSync(reason: "ready" | ResyncReason): void;
}

const MIN_RECOVERY_DELAY_MS = 5_000;
const MAX_RECOVERY_DELAY_MS = 60_000;

/**
 * Keeps one live connection for the signed-in user's active organization and reports its status. The connection is
 * rebuilt when the user or active organization changes; the callbacks may change on every render without reconnecting.
 */
export function useRealtime(subscriber: RealtimeSubscriber): RealtimeStatus {
  const { state, refresh } = useSession();
  const [status, setStatus] = useState<RealtimeStatus>("offline");
  const [epoch, setEpoch] = useState(0);
  const latest = useRef(subscriber);
  const lostInARow = useRef(0);

  useEffect(() => {
    latest.current = subscriber;
  });

  const identity = state.status === "authenticated" && state.me.role ? `${state.me.user.id}:${state.me.activeOrganizationId ?? ""}` : null;

  useEffect(() => {
    if (!identity) {
      setStatus("offline");
      return;
    }
    let recoveryTimer: ReturnType<typeof setTimeout> | null = null;
    const connection = startRealtime({
      createSocket: () => createSocket(API_URL),
      handlers: {
        onStatus: setStatus,
        onEvent: (message) => latest.current.onEvent(message),
        onSync: (reason) => {
          if (reason === "ready") lostInARow.current = 0;
          latest.current.onSync(reason);
        },
        onAccessLost: () => {
          // Ask the server what the session looks like now. Signed out -> the app redirects to sign-in; still signed
          // in -> reconnect, but with a growing pause so a persistent refusal cannot become a request loop.
          lostInARow.current += 1;
          const delay = Math.min(MAX_RECOVERY_DELAY_MS, MIN_RECOVERY_DELAY_MS * 2 ** (lostInARow.current - 1));
          void refresh().then(() => {
            recoveryTimer = setTimeout(() => setEpoch((value) => value + 1), delay);
          });
        },
      },
    });
    return () => {
      connection.stop();
      if (recoveryTimer) clearTimeout(recoveryTimer);
    };
  }, [identity, epoch, refresh]);

  return status;
}
