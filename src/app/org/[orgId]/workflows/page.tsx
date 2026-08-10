"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Bot, Cable, Clock3, MoreHorizontal, Play, Plus, Search, Workflow } from "lucide-react";
import { useOrganization } from "@/components/org-shell";
import { graphql } from "@/lib/graphql";
import { demoMode } from "@/lib/nhost";
import { DEMO_RUN_ID, demoWorkflows } from "@/lib/demo-data";

interface WorkflowRow {
  id: string; name: string; description: string; enabled: boolean; updated_at: string;
  steps: Array<{ id: string; type: string; name: string; position: number }>;
  triggers: Array<{ id: string; type: string; enabled: boolean }>;
  runs: Array<{ id: string; status: string; created_at: string }>;
}

const WORKFLOWS_QUERY = `query OrganizationWorkflows($orgId: uuid!) {
  workflows(where: {organization_id: {_eq: $orgId}, archived_at: {_is_null: true}}, order_by: {updated_at: desc}) {
    id name description enabled updated_at
    steps(order_by: {position: asc}) { id type name position }
    triggers { id type enabled }
    runs(limit: 1, order_by: {created_at: desc}) { id status created_at }
  }
}`;

export default function WorkflowsPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const { role, organization } = useOrganization();
  const [workflows, setWorkflows] = useState<WorkflowRow[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState<string | null>(null);

  useEffect(() => {
    if (demoMode) { setWorkflows(demoWorkflows as WorkflowRow[]); setLoading(false); return; }
    graphql<{ workflows: WorkflowRow[] }>(WORKFLOWS_QUERY, { orgId })
      .then((data) => setWorkflows(data.workflows)).finally(() => setLoading(false));
  }, [orgId]);

  const filtered = useMemo(() => workflows.filter((workflow) => `${workflow.name} ${workflow.description}`.toLowerCase().includes(search.toLowerCase())), [workflows, search]);

  async function runWorkflow(workflowId: string) {
    if (role === "viewer") return;
    setRunning(workflowId);
    try {
      if (demoMode) { await new Promise((resolve) => setTimeout(resolve, 550)); router.push(`/org/${orgId}/runs/${DEMO_RUN_ID}`); return; }
      const data = await graphql<{ triggerWorkflowRun: { run_id: string } }>(`mutation RunWorkflow($workflowId: uuid!, $input: jsonb!, $requestId: String!) {
        triggerWorkflowRun(workflow_id: $workflowId, input: $input, client_request_id: $requestId) { run_id status }
      }`, { workflowId, input: { message: "Please review and approve this customer escalation." }, requestId: crypto.randomUUID() });
      router.push(`/org/${orgId}/runs/${data.triggerWorkflowRun.run_id}`);
    } finally { setRunning(null); }
  }

  return (
    <div className="content-page">
      <header className="page-header">
        <div><span className="page-kicker">{organization.name}</span><h1>Workflows</h1><p>Design, trigger and monitor your organization&apos;s AI operations.</p></div>
        {role !== "viewer" && <Link className="button button-primary" href={`/org/${orgId}/workflows/new`}><Plus size={17} /> New workflow</Link>}
      </header>

      <section className="metric-row">
        <article><span className="metric-icon violet"><Workflow /></span><div><small>ACTIVE WORKFLOWS</small><strong>{workflows.filter((item) => item.enabled).length}</strong></div></article>
        <article><span className="metric-icon teal"><Play /></span><div><small>RUNS THIS MONTH</small><strong>{organization.quota_used}</strong></div></article>
        <article><span className="metric-icon amber"><Clock3 /></span><div><small>QUOTA REMAINING</small><strong>{organization.quota_allowed - organization.quota_used}</strong></div></article>
      </section>

      <div className="list-toolbar"><label className="search-box"><Search /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search workflows…" /></label><span>{filtered.length} workflows</span></div>

      <section className="workflow-list">
        {loading ? [1, 2].map((item) => <div className="workflow-row skeleton" key={item} />) : filtered.map((workflow) => {
          const latest = workflow.runs[0];
          return (
            <article className="workflow-row" key={workflow.id}>
              <span className="workflow-avatar"><Bot /></span>
              <div className="workflow-info"><Link href={`/org/${orgId}/workflows/${workflow.id}`}>{workflow.name}</Link><p>{workflow.description || "No description"}</p><div className="workflow-meta"><span><Cable /> {workflow.triggers.map((item) => item.type.replace("_", " ")).join(" · ") || "Manual"}</span><span>{workflow.steps.length} steps</span></div></div>
              <div className="workflow-run-state"><small>LATEST RUN</small>{latest ? <Link href={`/org/${orgId}/runs/${latest.id}`} className={`status-pill ${latest.status}`}><i />{latest.status}</Link> : <span className="muted">Never run</span>}</div>
              <div className="workflow-actions">{role !== "viewer" && <button className="button button-secondary button-small" onClick={() => runWorkflow(workflow.id)} disabled={running === workflow.id}><Play size={14} />{running === workflow.id ? "Queuing…" : "Run"}</button>}<Link className="icon-button" href={`/org/${orgId}/workflows/${workflow.id}`} aria-label="Edit workflow"><ArrowRight /></Link><button className="icon-button" aria-label="More options"><MoreHorizontal /></button></div>
            </article>
          );
        })}
        {!loading && !filtered.length && <div className="empty-state"><span><Workflow /></span><h2>No workflows found</h2><p>Build your first workflow to begin automating work.</p>{role !== "viewer" && <Link className="button button-primary" href={`/org/${orgId}/workflows/new`}><Plus /> New workflow</Link>}</div>}
      </section>
    </div>
  );
}
