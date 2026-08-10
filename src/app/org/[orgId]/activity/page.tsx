"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, ArrowRight, Clock3, Play } from "lucide-react";
import { graphql } from "@/lib/graphql";
import { demoMode } from "@/lib/nhost";
import { DEMO_RUN_ID } from "@/lib/demo-data";

interface Run { id: string; status: string; trigger_type: string; created_at: string; completed_at: string | null; workflow: { name: string } }
export default function ActivityPage() {
  const { orgId } = useParams<{ orgId: string }>();
  const [runs, setRuns] = useState<Run[]>([]);
  useEffect(() => {
    if (demoMode) { setRuns([{ id: DEMO_RUN_ID, status: "paused", trigger_type: "manual", created_at: new Date().toISOString(), completed_at: null, workflow: { name: "AI support triage" } }, { id: "2", status: "succeeded", trigger_type: "webhook", created_at: new Date(Date.now() - 3600000).toISOString(), completed_at: new Date(Date.now() - 3595000).toISOString(), workflow: { name: "Lead qualification" } }]); return; }
    graphql<{ workflow_runs: Run[] }>(`query Runs($orgId: uuid!) { workflow_runs(where: {organization_id: {_eq: $orgId}}, order_by: {created_at: desc}, limit: 50) { id status trigger_type created_at completed_at workflow { name } } }`, { orgId }).then((data) => setRuns(data.workflow_runs));
  }, [orgId]);
  return <div className="content-page"><header className="page-header"><div><span className="page-kicker">OBSERVABILITY</span><h1>Run activity</h1><p>Recent executions across every workflow in this organization.</p></div></header><section className="simple-panel"><div className="section-title"><div><span className="metric-icon small violet"><Activity /></span><div><h2>Execution history</h2><p>{runs.length} recent runs</p></div></div></div><div className="activity-list">{runs.map((run) => <Link key={run.id} href={`/org/${orgId}/runs/${run.id}`}><span className={`run-icon ${run.status}`}><Play /></span><div><strong>{run.workflow.name}</strong><p><Clock3 />{new Date(run.created_at).toLocaleString()} · {run.trigger_type}</p></div><span className={`status-pill ${run.status}`}><i />{run.status}</span><ArrowRight /></Link>)}</div></section></div>;
}
