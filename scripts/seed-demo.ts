import { createHash } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL ?? "";
const authUrl = (process.env.NHOST_AUTH_URL ?? "https://local.auth.local.nhost.run/v1").replace(/\/$/, "");
const password = process.env.DEMO_PASSWORD ?? "AgentForge!2026";

if (!databaseUrl) throw new Error("Set DATABASE_URL before running the demo seed");

async function main() {
const users = [
  { email: "owner-a@agentforge.demo", name: "Avery Morgan" },
  { email: "editor-a@agentforge.demo", name: "Sam Rivera" },
  { email: "viewer-a@agentforge.demo", name: "Jordan Lee" },
  { email: "owner-b@agentforge.demo", name: "Taylor Kim" },
];

for (const user of users) {
  const response = await fetch(`${authUrl}/signup/email-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: user.email,
      password,
      options: { displayName: user.name, defaultRole: "user", allowedRoles: ["user", "me"] },
    }),
  });
  if (!response.ok && response.status !== 409) {
    const message = await response.text();
    if (!/already|exist/i.test(message)) throw new Error(`Could not create ${user.email}: ${message}`);
  }
}

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: /localhost|127\.0\.0\.1|@postgres(?::|\/)/.test(databaseUrl) ? false : { rejectUnauthorized: false },
});
const client = await pool.connect();

try {
  await client.query("BEGIN");
  const userRows = await client.query<{ id: string; email: string }>(
    `SELECT id, email FROM auth.users WHERE email = ANY($1::text[])`,
    [users.map((user) => user.email)],
  );
  const ids = new Map(userRows.rows.map((user) => [user.email, user.id]));
  if (ids.size !== users.length) throw new Error("Not all demo Auth users were found; disable email-verification restrictions and retry");

  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  await client.query(
    `INSERT INTO public.organizations (id, name, slug, quota_allowed, quota_used)
     VALUES ($1, 'Northstar Operations', 'northstar-operations', 100, 37),
            ($2, 'Atlas Commerce', 'atlas-commerce', 50, 4)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, quota_allowed = EXCLUDED.quota_allowed`,
    [orgA, orgB],
  );
  const memberships = [
    [orgA, ids.get(users[0].email), "owner"],
    [orgA, ids.get(users[1].email), "editor"],
    [orgA, ids.get(users[2].email), "viewer"],
    [orgB, ids.get(users[3].email), "owner"],
  ];
  for (const membership of memberships) {
    await client.query(
      `INSERT INTO public.org_members (organization_id, user_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      membership,
    );
  }

  const workflowId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await client.query(
    `INSERT INTO public.workflows (id, organization_id, name, description, created_by)
     VALUES ($1, $2, 'AI support triage', 'Classify inbound issues, enrich them, and pause before escalation.', $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description`,
    [workflowId, orgA, ids.get(users[0].email)],
  );
  await client.query(`DELETE FROM public.workflow_steps WHERE workflow_id = $1`, [workflowId]);
  const steps = [
    ["classify_request", "Classify request", 0, "llm_call", { system_prompt: "Return JSON with decision and summary fields.", prompt_template: "Classify: {{run.input.message}}. Use decision approve or reject.", response_format: "json" }, "check_decision"],
    ["check_decision", "Check AI decision", 1, "conditional_branch", { source_step_key: "classify_request", path: "decision", operator: "eq", value: "approve", true_next_key: "enrich_request", false_next_key: "human_approval" }, null],
    ["enrich_request", "Enrich request", 2, "http_request", { method: "GET", url: "https://jsonplaceholder.typicode.com/todos/1", headers: {}, timeout_ms: 8000 }, "human_approval"],
    ["human_approval", "Operations approval", 3, "approval_gate", { message: "Review the AI decision before continuing." }, "save_result"],
    ["save_result", "Save result", 4, "db_write", { key_template: "support-triage", value_template: "{{steps.classify_request.output}}" }, "notify_support"],
    ["notify_support", "Notify support", 5, "notify", { channel: "demo", message_template: "Approved: {{steps.classify_request.output.summary}}" }, null],
  ];
  for (const step of steps) {
    await client.query(
      `INSERT INTO public.workflow_steps (workflow_id, step_key, name, position, type, config, next_step_key)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
      [workflowId, step[0], step[1], step[2], step[3], JSON.stringify(step[4]), step[5]],
    );
  }
  await client.query(`DELETE FROM public.workflow_triggers WHERE workflow_id = $1`, [workflowId]);
  const webhookSecret = "northstar-demo-webhook-secret";
  await client.query(
    `INSERT INTO public.workflow_triggers (workflow_id, type, config, enabled, secret_hash, next_run_at)
     VALUES
       ($1, 'manual', '{}'::jsonb, true, NULL, NULL),
       ($1, 'webhook', '{}'::jsonb, true, $2, NULL),
       ($1, 'database_event', '{"source":"workflow_signals"}'::jsonb, true, NULL, NULL),
       ($1, 'scheduled', '{"interval_minutes":60}'::jsonb, true, NULL, now() + interval '1 hour')`,
    [workflowId, createHash("sha256").update(webhookSecret).digest("hex")],
  );
  await client.query("COMMIT");

  console.log("Demo data created.");
  console.log(`Password for every demo user: ${password}`);
  console.log(`Webhook secret: ${webhookSecret}`);
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
