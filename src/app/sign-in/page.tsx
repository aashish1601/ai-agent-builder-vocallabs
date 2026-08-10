"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowRight, CheckCircle2, LockKeyhole, Sparkles } from "lucide-react";
import { useAuth } from "@/components/auth-provider";

export default function SignInPage() {
  const router = useRouter();
  const { signIn, isDemo } = useAuth();
  const [email, setEmail] = useState(isDemo ? "owner@northstar.demo" : "");
  const [password, setPassword] = useState(isDemo ? "demo-password" : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true); setError("");
    try {
      await signIn(email, password);
      router.push("/workspace");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in");
    } finally { setBusy(false); }
  }

  return (
    <main className="auth-page">
      <section className="auth-story">
        <Link href="/" className="brand brand-light"><span className="brand-mark"><Sparkles size={18} /></span>AgentForge</Link>
        <div className="auth-story-copy">
          <div className="eyebrow eyebrow-dark"><span className="live-dot" /> Workflow control plane</div>
          <h1>Build fast.<br />Operate safely.</h1>
          <p>Everything your team needs to ship AI-powered operations without compromising security.</p>
          <ul>
            <li><CheckCircle2 /> Tenant isolation at every data boundary</li>
            <li><CheckCircle2 /> Durable pause and resume execution</li>
            <li><CheckCircle2 /> Real-time GraphQL run visibility</li>
          </ul>
        </div>
        <p className="auth-footnote"><LockKeyhole size={14} /> Nhost Auth · Hasura permissions · PostgreSQL</p>
      </section>
      <section className="auth-form-wrap">
        <form className="auth-form" onSubmit={submit}>
          <div className="mobile-brand"><span className="brand-mark"><Sparkles size={18} /></span>AgentForge</div>
          <span className="form-kicker">WELCOME BACK</span>
          <h2>Sign in to your workspace</h2>
          <p>Use your organization account to continue.</p>
          {isDemo && <div className="demo-callout"><strong>Demo mode is active</strong><span>The credentials below open a populated owner workspace.</span></div>}
          <label>Email address<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
          <label>Password<input required type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••••••" /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="button button-primary button-full" disabled={busy}>{busy ? "Signing in…" : "Continue"}<ArrowRight size={17} /></button>
          <p className="form-legal">Access is restricted by your organization membership and role.</p>
        </form>
      </section>
    </main>
  );
}
