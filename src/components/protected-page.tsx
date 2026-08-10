"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";

export function ProtectedPage({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { session, loading } = useAuth();
  useEffect(() => {
    if (!loading && !session) router.replace("/sign-in");
  }, [loading, session, router]);
  if (loading || !session) return <div className="page-loader"><span className="loader-mark" />Checking your workspace…</div>;
  return children;
}
