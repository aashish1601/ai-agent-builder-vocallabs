import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { pool, transaction } from "./db";
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
    await client.query(
      `WITH deleted_steps AS (
         DELETE FROM public.workflow_steps WHERE workflow_id = $1 RETURNING id
       )
       DELETE FROM public.workflow_triggers WHERE workflow_id = $1`,
      [workflowId],
    );

    const stepRows = spec.steps.map((step, position) => ({
      id: step.id ?? null,
      step_key: step.step_key,
      name: step.name,
      position,
      type: step.type,
      config: step.config,
      next_step_key: step.next_step_key ?? null,
    }));
    await client.query(
      `INSERT INTO public.workflow_steps
        (id, workflow_id, step_key, name, position, type, config, next_step_key)
       SELECT COALESCE(item.id, gen_random_uuid()), $1, item.step_key, item.name,
              item.position, item.type, item.config, item.next_step_key
         FROM jsonb_to_recordset($2::jsonb) AS item(
           id uuid, step_key text, name text, position integer, type text,
           config jsonb, next_step_key text
         )`,
      [workflowId, JSON.stringify(stepRows)],
    );

    let revealedWebhookSecret: string | null = null;
    const triggerRows = [];
    for (const trigger of spec.triggers) {
      const old = (trigger.id ? oldTriggerById.get(trigger.id) : undefined) ?? oldTriggerByType.get(trigger.type);
      let hash = trigger.type === "webhook" ? old?.secret_hash ?? null : null;
      if (trigger.type === "webhook" && !hash) {
        revealedWebhookSecret = randomBytes(32).toString("base64url");
        hash = secretHash(revealedWebhookSecret);
      }
      const interval = Number(trigger.config.interval_minutes ?? 60);
      const nextRunAt = trigger.type === "scheduled" ? new Date(Date.now() + Math.max(1, interval) * 60_000) : null;
      triggerRows.push({
        id: trigger.id ?? null,
        type: trigger.type,
        config: trigger.config,
        secret_hash: hash,
        enabled: trigger.enabled ?? true,
        next_run_at: nextRunAt?.toISOString() ?? null,
      });
    }
    await client.query(
      `INSERT INTO public.workflow_triggers
        (id, workflow_id, type, config, secret_hash, enabled, next_run_at)
       SELECT COALESCE(item.id, gen_random_uuid()), $1, item.type, item.config,
              item.secret_hash, item.enabled, item.next_run_at
         FROM jsonb_to_recordset($2::jsonb) AS item(
           id uuid, type text, config jsonb, secret_hash text,
           enabled boolean, next_run_at timestamptz
         )`,
      [workflowId, JSON.stringify(triggerRows)],
    );

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
  if (options.requireInteractiveRole && !options.userId) {
    throw new HttpError("Authentication required", 401, "unauthenticated");
  }

  const result = await pool.query<{
    run_id: string | null;
    run_status: string | null;
    error_code: "not-found" | "invalid-workflow" | "quota-exhausted" | null;
  }>(
    `WITH request AS MATERIALIZED (
       SELECT $1::uuid AS workflow_id,
              $2::uuid AS trigger_id,
              $3::text AS trigger_type,
              $4::jsonb AS run_input,
              $5::text AS idempotency_key,
              $6::uuid AS user_id,
              $7::boolean AS require_interactive_role,
              pg_advisory_xact_lock(hashtextextended($1::text || ':' || $5, 0)) AS locked
     ),
     context AS MATERIALIZED (
       SELECT request.*,
              workflow.id AS found_workflow_id,
              workflow.organization_id,
              workflow.version,
              workflow.enabled,
              workflow.archived_at,
              organization.quota_allowed,
              organization.quota_used,
              organization.quota_reserved,
              organization.quota_period_start,
              existing_run.id AS existing_run_id,
              existing_run.status AS existing_run_status,
              EXISTS (
                SELECT 1 FROM public.org_members member
                 WHERE member.organization_id = workflow.organization_id
                   AND member.user_id = request.user_id
                   AND member.role IN ('owner', 'editor')
              ) AS can_start,
              EXISTS (
                SELECT 1 FROM public.workflow_steps step
                 WHERE step.workflow_id = workflow.id
              ) AS has_steps
         FROM request
         LEFT JOIN public.workflows workflow ON workflow.id = request.workflow_id
         LEFT JOIN public.organizations organization ON organization.id = workflow.organization_id
         LEFT JOIN public.workflow_runs existing_run
           ON existing_run.workflow_id = request.workflow_id
          AND existing_run.idempotency_key = request.idempotency_key
     ),
     checked AS MATERIALIZED (
       SELECT context.*,
              CASE
                WHEN found_workflow_id IS NULL OR NOT enabled OR archived_at IS NOT NULL THEN 'not-found'
                WHEN require_interactive_role AND NOT can_start THEN 'not-found'
                WHEN NOT has_steps THEN 'invalid-workflow'
                ELSE NULL
              END AS pre_error
         FROM context
     ),
     reserved AS (
       UPDATE public.organizations organization
          SET quota_used = CASE
                WHEN date_trunc('month', organization.quota_period_start) = date_trunc('month', now())
                  THEN organization.quota_used ELSE 0
              END,
              quota_reserved = CASE
                WHEN date_trunc('month', organization.quota_period_start) = date_trunc('month', now())
                  THEN organization.quota_reserved + 1 ELSE 1
              END,
              quota_period_start = date_trunc('month', now())::date
         FROM checked
        WHERE organization.id = checked.organization_id
          AND checked.pre_error IS NULL
          AND checked.existing_run_id IS NULL
          AND (
            CASE
              WHEN date_trunc('month', organization.quota_period_start) = date_trunc('month', now())
                THEN organization.quota_used + organization.quota_reserved
              ELSE 0
            END
          ) < organization.quota_allowed
       RETURNING organization.id
     ),
     inserted_run AS (
       INSERT INTO public.workflow_runs
         (workflow_id, organization_id, trigger_id, trigger_type, status, input,
          definition_version, idempotency_key, started_by)
       SELECT checked.found_workflow_id, checked.organization_id, checked.trigger_id,
              checked.trigger_type, 'queued', checked.run_input, checked.version,
              checked.idempotency_key, checked.user_id
         FROM checked
         JOIN reserved ON reserved.id = checked.organization_id
       ON CONFLICT (workflow_id, idempotency_key)
         WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING id, status
     ),
     inserted_steps AS (
       INSERT INTO public.step_runs
         (workflow_run_id, source_step_id, step_key, name, position, type, config_snapshot, next_step_key)
       SELECT inserted_run.id, step.id, step.step_key, step.name, step.position,
              step.type, step.config, step.next_step_key
         FROM inserted_run
         JOIN public.workflow_steps step ON step.workflow_id = $1::uuid
        ORDER BY step.position
       RETURNING id, workflow_run_id, position
     ),
     inserted_job AS (
       INSERT INTO public.workflow_jobs (workflow_run_id, step_run_id)
       SELECT workflow_run_id, id
         FROM inserted_steps
        ORDER BY position
        LIMIT 1
       RETURNING id
     ),
     inserted_audit AS (
       INSERT INTO public.audit_events
         (organization_id, actor_user_id, action, resource_type, resource_id, metadata)
       SELECT checked.organization_id, checked.user_id, 'workflow.run_started',
              'workflow_run', inserted_run.id,
              jsonb_build_object('trigger_type', checked.trigger_type)
         FROM checked
         JOIN inserted_run ON true
       RETURNING id
     )
     SELECT COALESCE(checked.existing_run_id, inserted_run.id) AS run_id,
            COALESCE(checked.existing_run_status, inserted_run.status) AS run_status,
            CASE
              WHEN checked.pre_error IS NOT NULL THEN checked.pre_error
              WHEN checked.existing_run_id IS NULL AND inserted_run.id IS NULL THEN 'quota-exhausted'
              ELSE NULL
            END AS error_code
       FROM checked
       LEFT JOIN inserted_run ON true`,
    [
      options.workflowId,
      options.triggerId ?? null,
      options.triggerType,
      JSON.stringify(options.input),
      options.idempotencyKey,
      options.userId ?? null,
      options.requireInteractiveRole ?? false,
    ],
  );

  const outcome = result.rows[0];
  if (!outcome || outcome.error_code === "not-found") {
    throw new HttpError("Workflow not found", 404, "not-found");
  }
  if (outcome.error_code === "invalid-workflow") {
    throw new HttpError("Workflow has no steps", 409, "invalid-workflow");
  }
  if (outcome.error_code === "quota-exhausted") {
    throw new HttpError("Organization workflow quota is exhausted", 429, "quota-exhausted");
  }
  if (!outcome.run_id || !outcome.run_status) {
    throw new Error("Workflow run could not be created");
  }
  return { runId: outcome.run_id, status: outcome.run_status };
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
