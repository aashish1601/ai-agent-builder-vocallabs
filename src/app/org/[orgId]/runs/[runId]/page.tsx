import { RunMonitor } from "@/components/run-monitor";

export default async function RunPage({ params }: { params: Promise<{ orgId: string; runId: string }> }) {
  const { orgId, runId } = await params;
  return <RunMonitor organizationId={orgId} runId={runId} />;
}
