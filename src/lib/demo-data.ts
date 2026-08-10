export const DEMO_ORG_ID = "11111111-1111-4111-8111-111111111111";
export const DEMO_WORKFLOW_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const DEMO_RUN_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

export const demoOrganization = {
  id: DEMO_ORG_ID,
  name: "Northstar Operations",
  slug: "northstar-operations",
  quota_allowed: 100,
  quota_used: 37,
  quota_reserved: 1,
};

export const demoWorkflows = [
  {
    id: DEMO_WORKFLOW_ID,
    name: "AI support triage",
    description: "Classify inbound issues, enrich them, and pause before escalation.",
    enabled: true,
    updated_at: new Date().toISOString(),
    steps: [
      { id: "1", type: "llm_call", name: "Classify request", position: 0 },
      { id: "2", type: "conditional_branch", name: "Check decision", position: 1 },
      { id: "3", type: "http_request", name: "Enrich ticket", position: 2 },
      { id: "4", type: "approval_gate", name: "Operations approval", position: 3 },
      { id: "5", type: "notify", name: "Notify support", position: 4 },
    ],
    triggers: [{ id: "t1", type: "manual", enabled: true }, { id: "t2", type: "webhook", enabled: true }],
    runs: [{ id: DEMO_RUN_ID, status: "paused", created_at: new Date().toISOString() }],
  },
  {
    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    name: "Lead qualification",
    description: "Score new leads and sync qualified prospects.",
    enabled: true,
    updated_at: new Date(Date.now() - 86_400_000).toISOString(),
    steps: [
      { id: "6", type: "llm_call", name: "Score lead", position: 0 },
      { id: "7", type: "db_write", name: "Store score", position: 1 },
    ],
    triggers: [{ id: "t3", type: "database_event", enabled: true }],
    runs: [{ id: "d", status: "succeeded", created_at: new Date(Date.now() - 3_600_000).toISOString() }],
  },
];

export const demoRunSteps = [
  { id: "r1", step_key: "classify", name: "Classify request", type: "llm_call", position: 0, status: "succeeded", attempt_count: 1, output: { decision: "approve", summary: "High-priority billing request" }, error: null, approved_by: null, approved_at: null },
  { id: "r2", step_key: "route", name: "Check decision", type: "conditional_branch", position: 1, status: "succeeded", attempt_count: 1, output: { matched: true }, error: null, approved_by: null, approved_at: null },
  { id: "r3", step_key: "enrich", name: "Enrich ticket", type: "http_request", position: 2, status: "succeeded", attempt_count: 1, output: { status: 200 }, error: null, approved_by: null, approved_at: null },
  { id: "r4", step_key: "approval", name: "Operations approval", type: "approval_gate", position: 3, status: "paused", attempt_count: 0, output: null, error: null, approved_by: null, approved_at: null },
  { id: "r5", step_key: "notify", name: "Notify support", type: "notify", position: 4, status: "pending", attempt_count: 0, output: null, error: null, approved_by: null, approved_at: null },
];
