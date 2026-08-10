import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { transaction } from "./db";
import { HttpError } from "./http";
import type { OrgRole, StepInput, TriggerInput, TriggerType, WorkflowSpec } from "./types";

interface MembershipRow {
  role: OrgRole;
}

interface WorkflowRow {
  id: string;
  organization_id: string;
  version: number;
  enabled: boolean;
  archived_at: string | null;
}

interface ExistingStep {
  id: string;
  step_key: string;
  type: string;
  config: Record<string, unknown>;
  next_step_key: string | null;
  name: string;
}

interface ExistingTrigger {
  id: string;
  type: string;
  config: Record<string, unknown>;
  enabled: boolean;
  secret_hash: string | null;
}

const OWNER_ONLY_STEPS = new Set(["db_write", "notify"]);

export function secretHash(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export async function membershipRole(
  client: PoolClient,
  organizationId: string,
  userId: string,
): Promise<OrgRole | null> {
  const result = await client.query<MembershipRow>(
    `SELECT role
       FROM public.org_members
      WHERE organization_id = $1 AND user_id = $2`,
    [organizationId, userId],
  );
  return result.rows[0]?.role ?? null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function editorCanSaveRestricted(
  existingSteps: ExistingStep[],
  existingTriggers: ExistingTrigger[],
  nextSteps: StepInput[],
  nextTriggers: TriggerInput[],
) {
  const nextById = new Map(nextSteps.filter((step) => step.id).map((step) => [step.id!, step]));
  const nextTriggersById = new Map(nextTriggers.filter((trigger) => trigger.id).map((trigger) => [trigger.id!, trigger]));

  for (const step of nextSteps) {
    if (!OWNER_ONLY_STEPS.has(step.type)) continue;
    const old = step.id ? existingSteps.find((item) => item.id === step.id) : undefined;
    if (
      !old ||
      old.type !== step.type ||
      old.name !== step.name ||
      old.next_step_key !== (step.next_step_key ?? null) ||
      canonical(old.config) !== canonical(step.config)
    ) {
      return false;
    }
  }

  for (const old of existingSteps.filter((step) => OWNER_ONLY_STEPS.has(step.type))) {
    if (!nextById.has(old.id)) return false;
  }

  for (const trigger of nextTriggers) {
    if (trigger.type !== "webhook") continue;
    const old = trigger.id ? existingTriggers.find((item) => item.id === trigger.id) : undefined;
    if (!old || canonical(old.config) !== canonical(trigger.config) || old.enabled !== (trigger.enabled ?? true)) {
      return false;
    }
  }

  for (const old of existingTriggers.filter((trigger) => trigger.type === "webhook")) {
    if (!nextTriggersById.has(old.id)) return false;
  }
  return true;
}

export async function saveWorkflow(spec: WorkflowSpec, userId: string) {
  return transaction(async (client) => {
    let workflow: WorkflowRow | null = null;
    if (spec.workflow_id) {
      const workflowResult = await client.query<WorkflowRow>(
        `SELECT id, organization_id, version, enabled, archived_at
           FROM public.workflows
          WHERE id = $1
          FOR UPDATE`,
        [spec.workflow_id],
      );
      workflow = workflowResult.rows[0] ?? null;
      if (!workflow || workflow.organization_id !== spec.organization_id) {
        throw new HttpError("Workflow not found", 404, "not-found");
      }
    }

    const role = await membershipRole(client, spec.organization_id, userId);
    if (!role || role === "viewer") throw new HttpError("Workflow not found", 404, "not-found");

    const existingSteps = workflow
      ? (
          await client.query<ExistingStep>(
            `SELECT id, step_key, type, config, next_step_key, name
               FROM public.workflow_steps WHERE workflow_id = $1`,
            [workflow.id],
          )
        ).rows
      : [];
    const existingTriggers = workflow
      ? (
          await client.query<ExistingTrigger>(
            `SELECT id, type, config, enabled, secret_hash
               FROM public.workflow_triggers WHERE workflow_id = $1`,
            [workflow.id],
          )
        ).rows
      : [];

    if (
      role === "editor" &&
      !editorCanSaveRestricted(existingSteps, existingTriggers, spec.steps, spec.triggers)
    ) {
      throw new HttpError(
        "Only an organization owner can add or change database writes, notifications, or webhook triggers",
        403,
        "owner-required",
      );
    }

    let workflowId: string;
    if (workflow) {
      workflowId = workflow.id;
      await client.query(
        `UPDATE public.workflows
            SET name = $2, description = $3, enabled = $4, version = version + 1
          WHERE id = $1`,
        [workflowId, spec.name, spec.description ?? "", spec.enabled ?? true],
      );
    } else {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO public.workflows (organization_id, name, description, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [spec.organization_id, spec.name, spec.description ?? "", spec.enabled ?? true, userId],
      );
      workflowId = inserted.rows[0].id;
    }

    const oldTriggerById = new Map(existingTriggers.map((trigger) => [trigger.id, trigger]));
    const oldTriggerByType = new Map(existingTriggers.map((trigger) => [trigger.type, trigger]));
    await client.query(`DELETE FROM public.workflow_steps WHERE workflow_id = $1`, [workflowId]);
    await client.query(`DELETE FROM public.workflow_triggers WHERE workflow_id = $1`, [workflowId]);

    for (const [position, step] of spec.steps.entries()) {
      await client.query(
        `INSERT INTO public.workflow_steps
          (id, workflow_id, step_key, name, position, type, config, next_step_key)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [
          step.id ?? null,
          workflowId,
          step.step_key,
          step.name,
          position,
          step.type,
          JSON.stringify(step.config),
          step.next_step_key ?? null,
        ],
      );
    }

    let revealedWebhookSecret: string | null = null;
    for (const trigger of spec.triggers) {
      const old = (trigger.id ? oldTriggerById.get(trigger.id) : undefined) ?? oldTriggerByType.get(trigger.type);
      let hash = trigger.type === "webhook" ? old?.secret_hash ?? null : null;
      if (trigger.type === "webhook" && !hash) {
        revealedWebhookSecret = randomBytes(32).toString("base64url");
        hash = secretHash(revealedWebhookSecret);
      }
      const interval = Number(trigger.config.interval_minutes ?? 60);
      const nextRunAt = trigger.type === "scheduled" ? new Date(Date.now() + Math.max(1, interval) * 60_000) : null;
      await client.query(
        `INSERT INTO public.workflow_triggers
          (id, workflow_id, type, config, secret_hash, enabled, next_run_at)
         VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4::jsonb, $5, $6, $7)`,
        [
          trigger.id ?? null,
          workflowId,
          trigger.type,
          JSON.stringify(trigger.config),
          hash,
          trigger.enabled ?? true,
          nextRunAt,
        ],
      );
    }

    await client.query(
      `INSERT INTO public.audit_events
        (organization_id, actor_user_id, action, resource_type, resource_id)
       VALUES ($1, $2, $3, 'workflow', $4)`,
      [spec.organization_id, userId, workflow ? "workflow.updated" : "workflow.created", workflowId],
    );

    return { workflowId, webhookSecret: revealedWebhookSecret };
  });
}

export interface StartRunOptions {
  workflowId: string;
  triggerId?: string | null;
  triggerType: TriggerType;
  input: Record<string, unknown>;
  idempotencyKey: string;
  userId?: string | null;
  requireInteractiveRole?: boolean;
}

export async function createWorkflowRun(options: StartRunOptions) {
  return transaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
      `${options.workflowId}:${options.idempotencyKey}`,
    ]);

    const duplicate = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM public.workflow_runs
        WHERE workflow_id = $1 AND idempotency_key = $2`,
      [options.workflowId, options.idempotencyKey],
    );
    if (duplicate.rows[0]) return { runId: duplicate.rows[0].id, status: duplicate.rows[0].status };

    const workflowResult = await client.query<WorkflowRow>(
      `SELECT id, organization_id, version, enabled, archived_at
         FROM public.workflows WHERE id = $1`,
      [options.workflowId],
    );
    const workflow = workflowResult.rows[0];
    if (!workflow || !workflow.enabled || workflow.archived_at) {
      throw new HttpError("Workflow not found", 404, "not-found");
    }

    if (options.requireInteractiveRole) {
      if (!options.userId) throw new HttpError("Authentication required", 401, "unauthenticated");
      const role = await membershipRole(client, workflow.organization_id, options.userId);
      if (!role || role === "viewer") throw new HttpError("Workflow not found", 404, "not-found");
    }

    const orgResult = await client.query<{
      quota_allowed: number;
      quota_used: number;
      quota_reserved: number;
      quota_period_start: string;
    }>(
      `SELECT quota_allowed, quota_used, quota_reserved, quota_period_start::text AS quota_period_start
         FROM public.organizations WHERE id = $1 FOR UPDATE`,
      [workflow.organization_id],
    );
    const org = orgResult.rows[0];
    if (!org) throw new HttpError("Workflow not found", 404, "not-found");

    const currentMonth = new Date().toISOString().slice(0, 7);
    if (String(org.quota_period_start).slice(0, 7) !== currentMonth) {
      org.quota_used = 0;
      org.quota_reserved = 0;
      await client.query(
        `UPDATE public.organizations
            SET quota_used = 0, quota_reserved = 0, quota_period_start = date_trunc('month', now())::date
          WHERE id = $1`,
        [workflow.organization_id],
      );
    }
    if (org.quota_used + org.quota_reserved >= org.quota_allowed) {
      throw new HttpError("Organization workflow quota is exhausted", 429, "quota-exhausted");
    }

    const steps = await client.query<{
      id: string;
      step_key: string;
      name: string;
      position: number;
      type: string;
      config: Record<string, unknown>;
      next_step_key: string | null;
    }>(
      `SELECT id, step_key, name, position, type, config, next_step_key
         FROM public.workflow_steps
        WHERE workflow_id = $1 ORDER BY position`,
      [workflow.id],
    );
    if (!steps.rows.length) throw new HttpError("Workflow has no steps", 409, "invalid-workflow");

    const runResult = await client.query<{ id: string }>(
      `INSERT INTO public.workflow_runs
        (workflow_id, organization_id, trigger_id, trigger_type, status, input,
         definition_version, idempotency_key, started_by)
       VALUES ($1, $2, $3, $4, 'queued', $5::jsonb, $6, $7, $8)
       RETURNING id`,
      [
        workflow.id,
        workflow.organization_id,
        options.triggerId ?? null,
        options.triggerType,
        JSON.stringify(options.input),
        workflow.version,
        options.idempotencyKey,
        options.userId ?? null,
      ],
    );
    const runId = runResult.rows[0].id;

    let firstStepRunId: string | null = null;
    for (const step of steps.rows) {
      const stepResult = await client.query<{ id: string }>(
        `INSERT INTO public.step_runs
          (workflow_run_id, source_step_id, step_key, name, position, type, config_snapshot, next_step_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         RETURNING id`,
        [runId, step.id, step.step_key, step.name, step.position, step.type, JSON.stringify(step.config), step.next_step_key],
      );
      if (!firstStepRunId) firstStepRunId = stepResult.rows[0].id;
    }

    await client.query(
      `INSERT INTO public.workflow_jobs (workflow_run_id, step_run_id)
       VALUES ($1, $2)`,
      [runId, firstStepRunId],
    );
    await client.query(
      `UPDATE public.organizations SET quota_reserved = quota_reserved + 1 WHERE id = $1`,
      [workflow.organization_id],
    );
    await client.query(
      `INSERT INTO public.audit_events
        (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'workflow.run_started', 'workflow_run', $3, $4::jsonb)`,
      [workflow.organization_id, options.userId ?? null, runId, JSON.stringify({ trigger_type: options.triggerType })],
    );
    return { runId, status: "queued" };
  });
}

async function finishRun(client: PoolClient, runId: string, organizationId: string) {
  await client.query(
    `UPDATE public.step_runs SET status = 'skipped', completed_at = now()
      WHERE workflow_run_id = $1 AND status = 'pending'`,
    [runId],
  );
  await client.query(
    `UPDATE public.workflow_runs
        SET status = 'succeeded', current_step_key = NULL, completed_at = now(), output = '{}'::jsonb
      WHERE id = $1`,
    [runId],
  );
  await client.query(
    `UPDATE public.organizations
        SET quota_reserved = GREATEST(quota_reserved - 1, 0), quota_used = quota_used + 1
      WHERE id = $1`,
    [organizationId],
  );
}

export async function approvePausedStep(stepRunId: string, userId: string) {
  return transaction(async (client) => {
    const result = await client.query<{
      id: string;
      workflow_run_id: string;
      status: string;
      next_step_key: string | null;
      position: number;
      organization_id: string;
      run_status: string;
      approved_by: string | null;
    }>(
      `SELECT sr.id, sr.workflow_run_id, sr.status, sr.next_step_key, sr.position,
              wr.organization_id, wr.status AS run_status, sr.approved_by
         FROM public.step_runs sr
         JOIN public.workflow_runs wr ON wr.id = sr.workflow_run_id
        WHERE sr.id = $1
        FOR UPDATE OF sr, wr`,
      [stepRunId],
    );
    const step = result.rows[0];
    if (!step) throw new HttpError("Approval step not found", 404, "not-found");

    const role = await membershipRole(client, step.organization_id, userId);
    if (!role || role === "viewer") throw new HttpError("Approval step not found", 404, "not-found");

    if (step.status === "succeeded" && step.approved_by) {
      return { runId: step.workflow_run_id, status: "running" };
    }
    if (step.status !== "paused" || step.run_status !== "paused") {
      throw new HttpError("This step is not awaiting approval", 409, "not-paused");
    }

    await client.query(
      `UPDATE public.step_runs
          SET status = 'succeeded', approved_by = $2::uuid, approved_at = now(), completed_at = now(),
              output = jsonb_build_object('approved', true, 'approved_by', ($2::uuid)::text)
        WHERE id = $1`,
      [step.id, userId],
    );
    await client.query(`UPDATE public.workflow_runs SET status = 'running' WHERE id = $1`, [step.workflow_run_id]);

    const next = await client.query<{ id: string }>(
      step.next_step_key
        ? `SELECT id FROM public.step_runs WHERE workflow_run_id = $1 AND step_key = $2 AND status = 'pending'`
        : `SELECT id FROM public.step_runs
            WHERE workflow_run_id = $1 AND position > $2 AND status = 'pending'
            ORDER BY position LIMIT 1`,
      step.next_step_key ? [step.workflow_run_id, step.next_step_key] : [step.workflow_run_id, step.position],
    );
    if (next.rows[0]) {
      await client.query(
        `INSERT INTO public.workflow_jobs (workflow_run_id, step_run_id)
         VALUES ($1, $2) ON CONFLICT (step_run_id) DO NOTHING`,
        [step.workflow_run_id, next.rows[0].id],
      );
    } else {
      await finishRun(client, step.workflow_run_id, step.organization_id);
    }

    await client.query(
      `INSERT INTO public.audit_events
        (organization_id, actor_user_id, action, resource_type, resource_id)
       VALUES ($1, $2, 'workflow.step_approved', 'step_run', $3)`,
      [step.organization_id, userId, step.id],
    );
    return { runId: step.workflow_run_id, status: next.rows[0] ? "running" : "succeeded" };
  });
}
