import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
import { HttpError } from "./http";
import type { StepType } from "./types";

interface ClaimedJob {
  job_id: string;
  workflow_run_id: string;
  organization_id: string;
  run_input: Record<string, unknown>;
  step_run_id: string;
  step_key: string;
  name: string;
  position: number;
  type: StepType;
  config_snapshot: Record<string, unknown>;
  next_step_key: string | null;
}

interface ExecutionContext {
  run: { id: string; input: Record<string, unknown> };
  steps: Record<string, { output: unknown; status: string }>;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function pathValue(value: unknown, path: string): unknown {
  if (!path) return value;
  return path.split(".").filter(Boolean).reduce<unknown>((current, part) => {
    if (current && typeof current === "object") return (current as Record<string, unknown>)[part];
    return undefined;
  }, value);
}

function renderString(template: string, context: ExecutionContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    const value = pathValue(context, expression.trim());
    if (value === undefined || value === null) return "";
    return typeof value === "string" ? value : JSON.stringify(value);
  });
}

function render(value: unknown, context: ExecutionContext): unknown {
  if (typeof value === "string") return renderString(value, context);
  if (Array.isArray(value)) return value.map((item) => render(item, context));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, render(item, context)]));
  }
  return value;
}

function isPrivateIp(address: string) {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  if (!address.includes(".")) return false;
  const parts = address.split(".").map(Number);
  return (
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    parts[0] === 0
  );
}

async function assertSafeUrl(rawUrl: string) {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") throw new Error("HTTP steps only permit HTTPS URLs");
  if (url.username || url.password) throw new Error("Credentials in HTTP step URLs are not permitted");
  if (url.hostname === "localhost" || url.hostname.endsWith(".local")) throw new Error("Private hosts are not permitted");

  const addresses = isIP(url.hostname)
    ? [{ address: url.hostname }]
    : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error("Private network destinations are not permitted");
  }
}

async function llmCall(config: Record<string, unknown>, context: ExecutionContext) {
  const prompt = renderString(String(config.prompt_template ?? ""), context);
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    await wait(900);
    const rejected = /\b(reject|negative|deny|unsafe)\b/i.test(prompt);
    return {
      decision: rejected ? "reject" : "approve",
      summary: `Stubbed LLM classification for: ${prompt.slice(0, 160)}`,
      provider: "disclosed-demo-stub",
    };
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: String(config.model ?? process.env.GROQ_MODEL ?? "llama-3.1-8b-instant"),
      messages: [
        { role: "system", content: String(config.system_prompt ?? "You are a precise workflow assistant.") },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      response_format: config.response_format === "json" ? { type: "json_object" } : undefined,
    }),
  });
  if (!response.ok) throw new Error(`Groq returned ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content ?? "";
  if (config.response_format === "json") {
    try {
      return JSON.parse(content) as unknown;
    } catch {
      throw new Error("The LLM did not return valid JSON");
    }
  }
  return { text: content };
}

async function httpRequest(config: Record<string, unknown>, context: ExecutionContext, stepRunId: string) {
  const url = renderString(String(config.url), context);
  await assertSafeUrl(url);
  const requestedHeaders = (render(config.headers ?? {}, context) ?? {}) as Record<string, unknown>;
  const headers: Record<string, string> = { "Idempotency-Key": stepRunId, Accept: "application/json" };
  for (const [key, value] of Object.entries(requestedHeaders)) {
    if (/^(authorization|cookie|host|content-length|x-forwarded-)/i.test(key)) continue;
    headers[key] = String(value);
  }

  const method = String(config.method ?? "GET");
  const body = method === "GET" ? undefined : JSON.stringify(render(config.body_template ?? {}, context));
  if (body) headers["Content-Type"] = "application/json";
  const response = await fetch(url, {
    method,
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(Number(config.timeout_ms ?? 8_000)),
  });
  if (!response.ok) throw new Error(`HTTP endpoint returned ${response.status}`);
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > 1_000_000) throw new Error("HTTP response exceeded 1 MB");
  const text = await response.text();
  if (text.length > 1_000_000) throw new Error("HTTP response exceeded 1 MB");
  const contentType = response.headers.get("content-type") ?? "";
  return {
    status: response.status,
    data: contentType.includes("application/json") ? JSON.parse(text) : text,
  };
}

function branch(config: Record<string, unknown>, context: ExecutionContext) {
  const source = context.steps[String(config.source_step_key)]?.output;
  const left = pathValue(source, String(config.path ?? ""));
  const right = config.value;
  let result = false;
  switch (config.operator) {
    case "eq": result = canonicalComparable(left) === canonicalComparable(right); break;
    case "neq": result = canonicalComparable(left) !== canonicalComparable(right); break;
    case "contains": result = String(left ?? "").includes(String(right ?? "")); break;
    case "gt": result = Number(left) > Number(right); break;
    case "gte": result = Number(left) >= Number(right); break;
    case "lt": result = Number(left) < Number(right); break;
    case "lte": result = Number(left) <= Number(right); break;
    case "exists": result = left !== undefined && left !== null; break;
  }
  return {
    output: { matched: result, actual: left, expected: right, operator: config.operator },
    nextStepKey: String(result ? config.true_next_key : config.false_next_key),
  };
}

function canonicalComparable(value: unknown) {
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

async function executeStep(job: ClaimedJob, context: ExecutionContext) {
  const config = job.config_snapshot;
  switch (job.type) {
    case "llm_call":
      return { output: await llmCall(config, context) };
    case "http_request":
      return { output: await httpRequest(config, context, job.step_run_id) };
    case "conditional_branch":
      return branch(config, context);
    case "db_write": {
      const key = renderString(String(config.key_template), context).slice(0, 120);
      const value = render(config.value_template, context);
      const saved = await pool.query<{ id: string }>(
        `INSERT INTO public.workflow_artifacts
          (organization_id, workflow_run_id, step_run_id, key, value)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (step_run_id, key) DO UPDATE SET value = EXCLUDED.value
         RETURNING id`,
        [job.organization_id, job.workflow_run_id, job.step_run_id, key, JSON.stringify(value)],
      );
      return { output: { artifact_id: saved.rows[0].id, key, value } };
    }
    case "notify": {
      const message = renderString(String(config.message_template), context);
      const queued = await pool.query<{ id: string }>(
        `INSERT INTO public.notification_outbox
          (organization_id, workflow_run_id, step_run_id, channel, destination, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         ON CONFLICT (step_run_id) DO UPDATE SET payload = EXCLUDED.payload
         RETURNING id`,
        [
          job.organization_id,
          job.workflow_run_id,
          job.step_run_id,
          String(config.channel ?? "demo"),
          config.destination ? renderString(String(config.destination), context) : null,
          JSON.stringify({ message }),
        ],
      );
      return { output: { notification_id: queued.rows[0].id, delivery_status: "queued" } };
    }
    case "approval_gate":
      return { output: null, paused: true };
  }
}

async function claimJob(jobId: string): Promise<ClaimedJob | null> {
  return transaction(async (client) => {
    const result = await client.query<ClaimedJob & { job_status: string; lease_until: string | null; step_status: string }>(
      `SELECT j.id AS job_id, j.status AS job_status, j.lease_until,
              wr.id AS workflow_run_id, wr.organization_id, wr.input AS run_input,
              sr.id AS step_run_id, sr.step_key, sr.name, sr.position, sr.type,
              sr.config_snapshot, sr.next_step_key, sr.status AS step_status
         FROM public.workflow_jobs j
         JOIN public.workflow_runs wr ON wr.id = j.workflow_run_id
         JOIN public.step_runs sr ON sr.id = j.step_run_id
        WHERE j.id = $1
        FOR UPDATE OF j, wr, sr`,
      [jobId],
    );
    const job = result.rows[0];
    if (!job || job.job_status === "completed") return null;
    if (job.job_status === "processing" && job.lease_until && new Date(job.lease_until) > new Date()) {
      throw new HttpError("Job is already being processed", 409, "job-leased");
    }
    if (["succeeded", "failed", "skipped"].includes(job.step_status)) {
      await client.query(`UPDATE public.workflow_jobs SET status = 'completed', lease_until = NULL WHERE id = $1`, [jobId]);
      return null;
    }
    await client.query(
      `UPDATE public.workflow_jobs
          SET status = 'processing', attempts = attempts + 1, lease_until = now() + interval '2 minutes'
        WHERE id = $1`,
      [jobId],
    );
    await client.query(
      `UPDATE public.step_runs
          SET status = 'running', started_at = COALESCE(started_at, now()), error = NULL
        WHERE id = $1`,
      [job.step_run_id],
    );
    await client.query(
      `UPDATE public.workflow_runs
          SET status = 'running', started_at = COALESCE(started_at, now()), current_step_key = $2
        WHERE id = $1`,
      [job.workflow_run_id, job.step_key],
    );
    return job;
  });
}

async function executionContext(job: ClaimedJob): Promise<ExecutionContext> {
  const outputs = await pool.query<{ step_key: string; output: unknown; status: string }>(
    `SELECT step_key, output, status FROM public.step_runs WHERE workflow_run_id = $1`,
    [job.workflow_run_id],
  );
  return {
    run: { id: job.workflow_run_id, input: job.run_input },
    steps: Object.fromEntries(outputs.rows.map((row) => [row.step_key, { output: row.output, status: row.status }])),
  };
}

async function finalizeSuccess(
  client: PoolClient,
  job: ClaimedJob,
  output: unknown,
  selectedNextKey?: string,
) {
  await client.query(
    `UPDATE public.step_runs
        SET status = 'succeeded', output = $2::jsonb, error = NULL, completed_at = now()
      WHERE id = $1`,
    [job.step_run_id, JSON.stringify(output ?? {})],
  );
  await client.query(
    `UPDATE public.workflow_jobs SET status = 'completed', lease_until = NULL, last_error = NULL WHERE id = $1`,
    [job.job_id],
  );
  const nextKey = selectedNextKey ?? job.next_step_key;
  const next = await client.query<{ id: string }>(
    nextKey
      ? `SELECT id FROM public.step_runs WHERE workflow_run_id = $1 AND step_key = $2 AND status = 'pending'`
      : `SELECT id FROM public.step_runs
          WHERE workflow_run_id = $1 AND position > $2 AND status = 'pending'
          ORDER BY position LIMIT 1`,
    nextKey ? [job.workflow_run_id, nextKey] : [job.workflow_run_id, job.position],
  );
  if (next.rows[0]) {
    await client.query(
      `INSERT INTO public.workflow_jobs (workflow_run_id, step_run_id)
       VALUES ($1, $2) ON CONFLICT (step_run_id) DO NOTHING`,
      [job.workflow_run_id, next.rows[0].id],
    );
    return "running";
  }

  await client.query(
    `UPDATE public.step_runs SET status = 'skipped', completed_at = now()
      WHERE workflow_run_id = $1 AND status = 'pending'`,
    [job.workflow_run_id],
  );
  await client.query(
    `UPDATE public.workflow_runs
        SET status = 'succeeded', current_step_key = NULL, completed_at = now(), output = $2::jsonb
      WHERE id = $1`,
    [job.workflow_run_id, JSON.stringify(output ?? {})],
  );
  await client.query(
    `UPDATE public.organizations
        SET quota_reserved = GREATEST(quota_reserved - 1, 0), quota_used = quota_used + 1
      WHERE id = $1`,
    [job.organization_id],
  );
  return "succeeded";
}

async function pauseJob(client: PoolClient, job: ClaimedJob) {
  await client.query(
    `UPDATE public.step_runs SET status = 'paused', output = NULL WHERE id = $1`,
    [job.step_run_id],
  );
  await client.query(`UPDATE public.workflow_jobs SET status = 'completed', lease_until = NULL WHERE id = $1`, [job.job_id]);
  await client.query(`UPDATE public.workflow_runs SET status = 'paused' WHERE id = $1`, [job.workflow_run_id]);
}

async function failJob(job: ClaimedJob, error: Error) {
  return transaction(async (client) => {
    await client.query(
      `UPDATE public.step_runs SET status = 'failed', error = $2, completed_at = now() WHERE id = $1`,
      [job.step_run_id, error.message.slice(0, 2_000)],
    );
    await client.query(
      `UPDATE public.workflow_jobs SET status = 'failed', lease_until = NULL, last_error = $2 WHERE id = $1`,
      [job.job_id, error.message.slice(0, 2_000)],
    );
    await client.query(
      `UPDATE public.step_runs SET status = 'skipped', completed_at = now()
        WHERE workflow_run_id = $1 AND status = 'pending'`,
      [job.workflow_run_id],
    );
    await client.query(
      `UPDATE public.workflow_runs
          SET status = 'failed', error = $2, current_step_key = NULL, completed_at = now()
        WHERE id = $1`,
      [job.workflow_run_id, error.message.slice(0, 2_000)],
    );
    await client.query(
      `UPDATE public.organizations
          SET quota_reserved = GREATEST(quota_reserved - 1, 0), quota_used = quota_used + 1
        WHERE id = $1`,
      [job.organization_id],
    );
    return { status: "failed", error: error.message };
  });
}

export async function processWorkflowJob(jobId: string) {
  const job = await claimJob(jobId);
  if (!job) return { status: "already-processed" };
  const context = await executionContext(job);

  if (job.type === "approval_gate") {
    await transaction((client) => pauseJob(client, job));
    return { status: "paused", runId: job.workflow_run_id };
  }

  let lastError: Error | null = null;
  const maxAttempts = job.type === "llm_call" || job.type === "http_request" ? 2 : 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await pool.query(`UPDATE public.step_runs SET attempt_count = attempt_count + 1 WHERE id = $1`, [job.step_run_id]);
    try {
      const result = await executeStep(job, context);
      const status = await transaction((client) =>
        finalizeSuccess(client, job, result.output, "nextStepKey" in result ? result.nextStepKey : undefined),
      );
      return { status, runId: job.workflow_run_id };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts) {
        await pool.query(`UPDATE public.step_runs SET status = 'retrying', error = $2 WHERE id = $1`, [
          job.step_run_id,
          lastError.message.slice(0, 2_000),
        ]);
        await wait(350 * 2 ** (attempt - 1));
        await pool.query(`UPDATE public.step_runs SET status = 'running' WHERE id = $1`, [job.step_run_id]);
      }
    }
  }
  return failJob(job, lastError ?? new Error("Step execution failed"));
}
