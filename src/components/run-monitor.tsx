"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { createClient, type Client } from "graphql-ws";
import { AlertCircle, ArrowLeft, Bot, Braces, Check, CheckCircle2, ChevronDown, CircleDashed, Clock3, Database, GitBranch, Globe2, Loader2, Mail, Pause, Play, Radio, RefreshCw, ShieldCheck, SkipForward, Sparkles, TerminalSquare, XCircle } from "lucide-react";
import { useOrganization } from "./org-shell";
import { graphql } from "@/lib/graphql";
import { demoMode, graphqlUrl, nhost } from "@/lib/nhost";
import { demoRunSteps } from "@/lib/demo-data";

interface StepRun {
  id: string; step_key: string; name: string; type: string; position: number; status: string;
  attempt_count: number; input?: unknown; output?: unknown; error: string | null; approved_by: string | null; approved_at: string | null;
}
interface RunData {
  id: string; status: string; trigger_type: string; input: unknown; output?: unknown; error: string | null;
  created_at: string; started_at: string | null; completed_at: string | null; current_step_key: string | null;
  workflow: { id: string; name: string };
  step_runs: StepRun[];
}

const RUN_FRAGMENT = `id status trigger_type input output error created_at started_at completed_at current_step_key
  workflow { id name }
  step_runs(order_by: {position: asc}) { id step_key name type position status attempt_count input output error approved_by approved_at }`;

export function RunMonitor({ organizationId, runId }: { organizationId: string; runId: string }) {
  const { role } = useOrganization();
  const [run, setRun] = useState<RunData | null>(null);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const socketRef = useRef<Client | null>(null);

  useEffect(() => {
    if (demoMode) {
      setRun({ id: runId, status: "paused", trigger_type: "manual", input: { message: "Please review and approve this customer escalation." }, error: null, created_at: new Date(Date.now() - 12_000).toISOString(), started_at: new Date(Date.now() - 11_000).toISOString(), completed_at: null, current_step_key: "approval", workflow: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "AI support triage" }, step_runs: demoRunSteps as StepRun[] });
      setLoading(false); setLive(true); return;
    }
    graphql<{ workflow_runs_by_pk: RunData | null }>(`query Run($id: uuid!) { workflow_runs_by_pk(id: $id) { ${RUN_FRAGMENT} } }`, { id: runId })
      .then(({ workflow_runs_by_pk }) => setRun(workflow_runs_by_pk)).finally(() => setLoading(false));

    const wsUrl = graphqlUrl.replace(/^http/, "ws");
    const client = createClient({
      url: wsUrl,
      connectionParams: () => ({ headers: { Authorization: `Bearer ${nhost.getUserSession()?.accessToken ?? ""}` } }),
      retryAttempts: 8,
    });
    socketRef.current = client;
    const dispose = client.subscribe<{ workflow_runs_by_pk: RunData | null }>(
      { query: `subscription RunProgress($id: uuid!) { workflow_runs_by_pk(id: $id) { ${RUN_FRAGMENT} } }`, variables: { id: runId } },
      { next: (result) => { if (result.data?.workflow_runs_by_pk) setRun(result.data.workflow_runs_by_pk); setLive(true); }, error: () => setLive(false), complete: () => setLive(false) },
    );
    return () => { dispose(); client.dispose(); socketRef.current = null; };
  }, [runId]);

  const completed = useMemo(() => run?.step_runs.filter((step) => ["succeeded", "skipped"].includes(step.status)).length ?? 0, [run]);
  const duration = run?.started_at ? Math.max(1, Math.round(((run.completed_at ? new Date(run.completed_at).getTime() : Date.now()) - new Date(run.started_at).getTime()) / 1000)) : 0;

  async function approve(stepId: string) {
    if (role === "viewer") return;
    setApproving(stepId);
    try {
      if (demoMode) {
        setRun((current) => current && ({ ...current, status: "running", current_step_key: "notify", step_runs: current.step_runs.map((step) => step.id === stepId ? { ...step, status: "succeeded", approved_by: "demo-owner", approved_at: new Date().toISOString(), output: { approved: true } } : step.step_key === "notify" ? { ...step, status: "running" } : step) }));
        await new Promise((resolve) => setTimeout(resolve, 1200));
        setRun((current) => current && ({ ...current, status: "succeeded", current_step_key: null, completed_at: new Date().toISOString(), step_runs: current.step_runs.map((step) => step.step_key === "notify" ? { ...step, status: "succeeded", attempt_count: 1, output: { delivery_status: "queued" } } : step) }));
        return;
      }
      await graphql(`mutation Approve($id: uuid!) { approveStep(step_run_id: $id) { run_id status } }`, { id: stepId });
    } finally { setApproving(null); }
  }

  if (loading) return <div className="run-loading"><Loader2 className="spin" /><p>Connecting to the live run…</p></div>;
  if (!run) return <div className="not-found"><XCircle /><h1>Run not found</h1><p>It may not exist, or your organization does not have access.</p><Link className="button button-secondary" href={`/org/${organizationId}/workflows`}>Back to workflows</Link></div>;

  return (
    <div className="content-page run-page">
      <header className="run-header">
        <div className="run-title"><Link className="icon-button" href={`/org/${organizationId}/workflows`}><ArrowLeft /></Link><div><span className="page-kicker">RUN / {run.id.slice(0, 8).toUpperCase()}</span><h1>{run.workflow.name}</h1><p>Started by {run.trigger_type.replace("_", " ")} trigger</p></div></div>
        <div className="run-header-actions"><span className={`live-badge ${live ? "connected" : ""}`}><Radio />{live ? "Live subscription" : "Reconnecting"}</span><span className={`status-pill large ${run.status}`}><i />{run.status}</span></div>
      </header>

      <section className="run-summary">
        <article><small>PROGRESS</small><strong>{completed} <span>/ {run.step_runs.length} steps</span></strong><div className="summary-progress"><i style={{ width: `${(completed / run.step_runs.length) * 100}%` }} /></div></article>
        <article><small>DURATION</small><strong>{duration}<span>s</span></strong><p>Execution time</p></article>
        <article><small>TRIGGER</small><strong className="summary-label"><Play />{run.trigger_type.replace("_", " ")}</strong><p>{new Date(run.created_at).toLocaleTimeString()}</p></article>
        <article><small>ATTEMPTS</small><strong>{run.step_runs.reduce((sum, step) => sum + step.attempt_count, 0)}</strong><p>Across all steps</p></article>
      </section>

      {run.status === "paused" && <div className="paused-banner"><span><Pause /></span><div><small>ACTION REQUIRED</small><h2>Workflow paused for approval</h2><p>An authorized owner or editor must approve the gate before execution can continue.</p></div></div>}
      {run.status === "failed" && <div className="failed-banner"><AlertCircle /><div><strong>Workflow failed</strong><p>{run.error}</p></div></div>}

      <div className="run-layout">
        <section className="timeline-panel"><div className="section-title"><div><span className="metric-icon small violet"><Sparkles /></span><div><h2>Execution timeline</h2><p>Updates stream directly from Hasura.</p></div></div></div><div className="timeline">
          {run.step_runs.map((step, index) => <TimelineStep key={step.id} step={step} last={index === run.step_runs.length - 1} expanded={expanded === step.id} onExpand={() => setExpanded(expanded === step.id ? null : step.id)} canApprove={role !== "viewer"} approving={approving === step.id} onApprove={() => approve(step.id)} />)}
        </div></section>
        <aside className="run-inspector"><div className="section-title"><div><span className="metric-icon small blue"><TerminalSquare /></span><div><h2>Run input</h2><p>Immutable execution payload</p></div></div></div><pre>{JSON.stringify(run.input, null, 2)}</pre><div className="security-proof"><ShieldCheck /><div><strong>Organization scoped</strong><p>This run and its subscription are filtered through the workflow&apos;s organization membership.</p></div></div><div className="run-facts"><p><span>Run ID</span><code>{run.id.slice(0, 13)}…</code></p><p><span>Current step</span><strong>{run.current_step_key ?? "—"}</strong></p><p><span>Started</span><strong>{run.started_at ? new Date(run.started_at).toLocaleTimeString() : "Queued"}</strong></p></div></aside>
      </div>
    </div>
  );
}

const stepIcons: Record<string, typeof Bot> = { llm_call: Bot, http_request: Globe2, conditional_branch: GitBranch, approval_gate: ShieldCheck, db_write: Database, notify: Mail };
function TimelineStep({ step, last, expanded, onExpand, canApprove, approving, onApprove }: { step: StepRun; last: boolean; expanded: boolean; onExpand(): void; canApprove: boolean; approving: boolean; onApprove(): void }) {
  const Icon = stepIcons[step.type] ?? Braces;
  const stateIcon = step.status === "succeeded" ? <Check /> : step.status === "failed" ? <XCircle /> : step.status === "paused" ? <Pause /> : step.status === "skipped" ? <SkipForward /> : step.status === "running" || step.status === "retrying" ? <Loader2 className="spin" /> : <CircleDashed />;
  return <div className={`timeline-step ${step.status}`}><div className="timeline-rail"><span>{stateIcon}</span>{!last && <i />}</div><div className="timeline-card"><button className="timeline-main" onClick={onExpand}><span className="step-icon muted"><Icon /></span><div><small>{step.type.replace("_", " ")}</small><strong>{step.name}</strong><p>{step.status === "retrying" ? `Retrying after attempt ${step.attempt_count}` : step.status === "paused" ? "Waiting for an authorized decision" : step.status === "succeeded" ? `Completed · ${step.attempt_count || 1} attempt${step.attempt_count > 1 ? "s" : ""}` : step.status}</p></div><span className={`status-pill ${step.status}`}><i />{step.status}</span><ChevronDown className={expanded ? "rotated" : ""} /></button>{step.status === "paused" && <div className="approval-action"><div><ShieldCheck /><span><strong>Approval required</strong><small>Owner or editor in this organization</small></span></div>{canApprove ? <button className="button button-primary button-small" disabled={approving} onClick={onApprove}>{approving ? <Loader2 className="spin" /> : <CheckCircle2 />}Approve & continue</button> : <span className="viewer-note">Viewers cannot approve</span>}</div>}{expanded && <div className="step-output"><div><small>OUTPUT</small>{step.error && <span className="error-label">Error</span>}</div><pre>{step.error || JSON.stringify(step.output ?? { status: step.status }, null, 2)}</pre></div>}</div></div>;
}
