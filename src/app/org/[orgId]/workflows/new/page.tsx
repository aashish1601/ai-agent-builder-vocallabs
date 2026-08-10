import { WorkflowBuilder } from "@/components/workflow-builder";

export default async function NewWorkflowPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  return <WorkflowBuilder organizationId={orgId} />;
}
