export {};

const url = process.env.NHOST_GRAPHQL_URL;
const orgAWorkflowId = process.env.SECURITY_ORG_A_WORKFLOW_ID;
const orgAStepRunId = process.env.SECURITY_ORG_A_PAUSED_STEP_ID;
const orgAToken = process.env.SECURITY_ORG_A_OWNER_TOKEN;
const orgBToken = process.env.SECURITY_ORG_B_OWNER_TOKEN;
const viewerToken = process.env.SECURITY_ORG_A_VIEWER_TOKEN;

if (![url, orgAWorkflowId, orgAStepRunId, orgAToken, orgBToken, viewerToken].every(Boolean)) {
  console.error("Missing security test environment. See README: Runtime isolation test.");
  process.exit(2);
}

async function request(token: string, query: string, variables: Record<string, unknown>) {
  const response = await fetch(url!, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  return response.json() as Promise<{ data?: Record<string, unknown>; errors?: Array<{ message: string }> }>;
}

async function main() {
  const byId = `query GuessWorkflow($id: uuid!) { workflows_by_pk(id: $id) { id name } }`;
  const orgARead = await request(orgAToken!, byId, { id: orgAWorkflowId });
  if (!(orgARead.data?.workflows_by_pk as { id?: string } | null)?.id) throw new Error("Org A owner could not read its workflow");

  const orgBRead = await request(orgBToken!, byId, { id: orgAWorkflowId });
  if (orgBRead.data?.workflows_by_pk !== null) throw new Error("Cross-org direct ID read was not isolated");

  const runMutation = `mutation GuessRun($id: uuid!) { triggerWorkflowRun(workflow_id: $id, input: {}, client_request_id: "isolation-test") { run_id } }`;
  const orgBRun = await request(orgBToken!, runMutation, { id: orgAWorkflowId });
  if (!orgBRun.errors?.length) throw new Error("Org B was able to trigger Org A workflow");

  const viewerRun = await request(viewerToken!, runMutation, { id: orgAWorkflowId });
  if (!viewerRun.errors?.length) throw new Error("Viewer was able to trigger a workflow");

  const approveMutation = `mutation GuessApproval($id: uuid!) { approveStep(step_run_id: $id) { run_id } }`;
  const orgBApprove = await request(orgBToken!, approveMutation, { id: orgAStepRunId });
  if (!orgBApprove.errors?.length) throw new Error("Org B was able to approve Org A step");

  console.log("PASS: Org A can read its workflow");
  console.log("PASS: Org B direct-ID read returned null");
  console.log("PASS: Org B trigger was denied");
  console.log("PASS: Viewer trigger was denied");
  console.log("PASS: Org B approval was denied");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
