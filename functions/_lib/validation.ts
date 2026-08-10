import { z } from "zod";
import type { StepInput, WorkflowSpec } from "./types";
import { HttpError } from "./http";

const key = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/);
const jsonObject = z.record(z.unknown());

const configSchemas = {
  llm_call: z.object({
    model: z.string().min(1).optional(),
    system_prompt: z.string().max(8_000).default("You are a precise workflow assistant."),
    prompt_template: z.string().min(1).max(20_000),
    response_format: z.enum(["text", "json"]).default("json"),
  }),
  http_request: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH"]).default("GET"),
    url: z.string().url(),
    headers: z.record(z.string()).optional(),
    body_template: z.unknown().optional(),
    timeout_ms: z.number().int().min(500).max(15_000).default(8_000),
  }),
  db_write: z.object({
    key_template: z.string().min(1).max(120),
    value_template: z.unknown(),
  }),
  notify: z.object({
    channel: z.enum(["slack", "email", "demo"]).default("demo"),
    destination: z.string().max(500).optional(),
    message_template: z.string().min(1).max(10_000),
  }),
  conditional_branch: z.object({
    source_step_key: key,
    path: z.string().max(200).default(""),
    operator: z.enum(["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists"]),
    value: z.unknown().optional(),
    true_next_key: key,
    false_next_key: key,
  }),
  approval_gate: z.object({
    message: z.string().min(1).max(1_000),
  }),
} satisfies Record<string, z.ZodTypeAny>;

const stepSchema = z.object({
  id: z.string().uuid().optional(),
  step_key: key,
  name: z.string().trim().min(1).max(120),
  type: z.enum(["llm_call", "http_request", "db_write", "notify", "conditional_branch", "approval_gate"]),
  config: jsonObject,
  next_step_key: key.nullable().optional(),
});

const triggerSchema = z.object({
  id: z.string().uuid().optional(),
  type: z.enum(["manual", "webhook", "scheduled", "database_event"]),
  enabled: z.boolean().default(true),
  config: jsonObject,
});

const workflowSchema = z.object({
  workflow_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid(),
  name: z.string().trim().min(2).max(160),
  description: z.string().max(2_000).default(""),
  enabled: z.boolean().default(true),
  steps: z.array(stepSchema).min(1).max(50),
  triggers: z.array(triggerSchema).max(12),
});

export function validateWorkflow(input: unknown): WorkflowSpec {
  const parsed = workflowSchema.safeParse(input);
  if (!parsed.success) {
    throw new HttpError(parsed.error.issues[0]?.message ?? "Invalid workflow", 400, "validation-failed");
  }

  const workflow = parsed.data;
  const keys = new Set(workflow.steps.map((step) => step.step_key));
  if (keys.size !== workflow.steps.length) {
    throw new HttpError("Step keys must be unique", 400, "validation-failed");
  }

  workflow.steps.forEach((step) => {
    const config = configSchemas[step.type].safeParse(step.config);
    if (!config.success) {
      throw new HttpError(
        `${step.name}: ${config.error.issues[0]?.message ?? "invalid configuration"}`,
        400,
        "validation-failed",
      );
    }
    step.config = config.data;

    const references = [step.next_step_key];
    if (step.type === "conditional_branch") {
      references.push(
        String(step.config.true_next_key),
        String(step.config.false_next_key),
        String(step.config.source_step_key),
      );
    }
    references.filter(Boolean).forEach((reference) => {
      if (!keys.has(reference!)) {
        throw new HttpError(`${step.name} references an unknown step: ${reference}`, 400, "validation-failed");
      }
    });
  });

  assertAcyclic(workflow.steps);
  return workflow as WorkflowSpec;
}

function assertAcyclic(steps: StepInput[]) {
  const byKey = new Map(steps.map((step, index) => [step.step_key, { step, index }]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const targets = (step: StepInput, index: number) => {
    if (step.type === "conditional_branch") {
      return [String(step.config.true_next_key), String(step.config.false_next_key)];
    }
    if (step.next_step_key) return [step.next_step_key];
    return steps[index + 1] ? [steps[index + 1].step_key] : [];
  };

  const walk = (stepKey: string) => {
    if (visiting.has(stepKey)) throw new HttpError("Workflow branches cannot contain cycles", 400, "validation-failed");
    if (visited.has(stepKey)) return;
    visiting.add(stepKey);
    const entry = byKey.get(stepKey);
    if (entry) targets(entry.step, entry.index).forEach(walk);
    visiting.delete(stepKey);
    visited.add(stepKey);
  };

  steps.forEach((step) => walk(step.step_key));
}
