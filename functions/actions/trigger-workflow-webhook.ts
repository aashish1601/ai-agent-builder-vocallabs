import { timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { actionBody, HttpError, methodGuard, sendError, verifyInternalWebhook } from "../_lib/http";
import { pool } from "../_lib/db";
import { createWorkflowRun, secretHash } from "../_lib/workflow-service";

interface WebhookInput {
  workflow_id: string;
  secret: string;
  payload?: Record<string, unknown> | null;
  event_id?: string | null;
}

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const action = actionBody<WebhookInput>(req);
    const input = action.input;
    const result = await pool.query<{ id: string; secret_hash: string }>(
      `SELECT id, secret_hash FROM public.workflow_triggers
        WHERE workflow_id = $1 AND type = 'webhook' AND enabled AND secret_hash IS NOT NULL
        ORDER BY created_at LIMIT 1`,
      [input.workflow_id],
    );
    const trigger = result.rows[0];
    const received = Buffer.from(secretHash(input.secret ?? ""), "hex");
    const expected = trigger ? Buffer.from(trigger.secret_hash, "hex") : Buffer.alloc(32);
    if (!trigger || received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new HttpError("Webhook not found", 404, "not-found");
    }

    const run = await createWorkflowRun({
      workflowId: input.workflow_id,
      triggerId: trigger.id,
      triggerType: "webhook",
      input: input.payload ?? {},
      idempotencyKey: `webhook:${input.event_id ?? secretHash(JSON.stringify(input.payload ?? {}) + Date.now())}`,
    });
    return res.status(200).json({ run_id: run.runId, status: run.status, message: "Webhook run queued" });
  } catch (error) {
    return sendError(res, error);
  }
}
