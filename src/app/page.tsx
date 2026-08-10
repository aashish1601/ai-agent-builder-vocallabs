import Link from "next/link";
import { ArrowRight, Blocks, Bot, CheckCircle2, GitBranch, ShieldCheck, Sparkles } from "lucide-react";

export default function HomePage() {
  return (
    <main className="marketing-page">
      <nav className="marketing-nav container">
        <Link href="/" className="brand brand-dark"><span className="brand-mark"><Sparkles size={18} /></span>AgentForge</Link>
        <div className="nav-actions">
          <span className="nav-note">Built on Nhost + Hasura</span>
          <Link className="button button-dark button-small" href="/sign-in">Open workspace <ArrowRight size={15} /></Link>
        </div>
      </nav>

      <section className="hero container">
        <div className="eyebrow"><span className="live-dot" /> Secure AI workflow operations</div>
        <h1>Turn business decisions into <em>reliable</em> AI workflows.</h1>
        <p className="hero-copy">Chain language models, APIs, approvals, databases and notifications—without giving up tenant isolation or operational control.</p>
        <div className="hero-actions">
          <Link className="button button-primary" href="/sign-in">Build a workflow <ArrowRight size={17} /></Link>
          <a className="button button-ghost" href="#how-it-works">See how it works</a>
        </div>
        <div className="trust-row">
          <span><CheckCircle2 size={16} /> Live step status</span>
          <span><CheckCircle2 size={16} /> Human approval gates</span>
          <span><CheckCircle2 size={16} /> Organization-scoped permissions</span>
        </div>
      </section>

      <section className="workflow-preview container" aria-label="Example workflow">
        <div className="preview-topbar"><div><i /><i /><i /></div><span>Customer escalation workflow</span><b>Active</b></div>
        <div className="preview-canvas">
          <PreviewNode icon={<Bot />} tone="violet" kicker="AI AGENT" title="Classify request" subtitle="Groq · JSON output" />
          <span className="flow-line" />
          <PreviewNode icon={<GitBranch />} tone="amber" kicker="CONDITION" title="High priority?" subtitle="decision = approve" />
          <span className="flow-line" />
          <PreviewNode icon={<ShieldCheck />} tone="teal" kicker="APPROVAL" title="Ops review" subtitle="Owner or editor" />
          <span className="flow-line" />
          <PreviewNode icon={<Blocks />} tone="blue" kicker="ACTION" title="Notify support" subtitle="Event Trigger" />
        </div>
      </section>

      <section id="how-it-works" className="feature-strip container">
        <article><span>01</span><h2>Design</h2><p>Compose typed steps and explicit branch paths in a focused workflow editor.</p></article>
        <article><span>02</span><h2>Control</h2><p>Use tenant-aware roles and owner-only controls for high-impact actions.</p></article>
        <article><span>03</span><h2>Operate</h2><p>Watch every attempt live, pause for approval, then resume without losing state.</p></article>
      </section>
    </main>
  );
}

function PreviewNode({ icon, tone, kicker, title, subtitle }: { icon: React.ReactNode; tone: string; kicker: string; title: string; subtitle: string }) {
  return <div className={`preview-node ${tone}`}><span className="preview-icon">{icon}</span><div><small>{kicker}</small><strong>{title}</strong><p>{subtitle}</p></div></div>;
}
