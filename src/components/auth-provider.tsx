"use client";

import type { StoredSession } from "@nhost/nhost-js/session";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { demoMode, nhost } from "@/lib/nhost";

interface DemoSession {
  accessToken: string;
  user: { id: string; email: string; displayName: string };
}

type AppSession = StoredSession | DemoSession;

interface AuthContextValue {
  session: AppSession | null;
  loading: boolean;
  isDemo: boolean;
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<AppSession | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (demoMode) {
      const active = window.localStorage.getItem("agent-forge-demo-session");
      if (active) setSession(JSON.parse(active) as DemoSession);
      setLoading(false);
      return;
    }
    setSession(nhost.getUserSession());
    setLoading(false);
    return nhost.sessionStorage.onChange((next) => setSession(next));
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (demoMode) {
      const next: DemoSession = {
        accessToken: "demo-token",
        user: { id: "00000000-0000-4000-8000-000000000001", email: email || "owner@northstar.demo", displayName: "Avery Morgan" },
      };
      window.localStorage.setItem("agent-forge-demo-session", JSON.stringify(next));
      setSession(next);
      return;
    }
    const response = await nhost.auth.signInEmailPassword({ email, password });
    if (!response.body.session) throw new Error("Sign in did not return a session");
  }, []);

  const signOut = useCallback(async () => {
    if (demoMode) {
      window.localStorage.removeItem("agent-forge-demo-session");
      setSession(null);
      return;
    }
    const current = nhost.getUserSession();
    if (current) await nhost.auth.signOut({ refreshToken: current.refreshToken });
    nhost.clearSession();
  }, []);

  const value = useMemo(() => ({ session, loading, isDemo: demoMode, signIn, signOut }), [session, loading, signIn, signOut]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
