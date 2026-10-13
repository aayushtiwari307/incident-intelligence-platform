"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { MeDto } from "@platform/shared";
import { createApiClient, ApiError, type ApiClient } from "./api-client";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:3001";

/** One client for the whole app. */
export const api: ApiClient = createApiClient(API_URL);

type SessionState = { status: "loading" } | { status: "anonymous" } | { status: "authenticated"; me: MeDto } | { status: "error"; message: string };

interface SessionValue {
  state: SessionState;
  setMe(me: MeDto): void;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      setState({ status: "authenticated", me: await api.me() });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) setState({ status: "anonymous" });
      else setState({ status: "error", message: error instanceof Error ? error.message : "Could not load your session" });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo<SessionValue>(
    () => ({
      state,
      setMe: (me) => setState({ status: "authenticated", me }),
      refresh,
      logout: async () => {
        try {
          await api.logout();
        } finally {
          setState({ status: "anonymous" });
        }
      },
    }),
    [state, refresh],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
