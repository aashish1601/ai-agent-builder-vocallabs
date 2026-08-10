import { WorkflowBuilder } from "@/components/workflow-builder";

export default async function EditWorkflowPage({ params }: { params: Promise<{ orgId: string; workflowId: string }> }) {
  const { orgId, workflowId } = await params;
  return <WorkflowBuilder organizationId={orgId} workflowId={workflowId} />;
}
