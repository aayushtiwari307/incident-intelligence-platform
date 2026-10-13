"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useSession } from "../lib/session";

export default function HomePage() {
  const { state } = useSession();
  const router = useRouter();
  useEffect(() => {
    if (state.status === "authenticated") router.replace("/incidents");
    if (state.status === "anonymous") router.replace("/login");
  }, [state.status, router]);
  return <p role="status" className="page-status">{state.status === "error" ? state.message : "Loading…"}</p>;
}
