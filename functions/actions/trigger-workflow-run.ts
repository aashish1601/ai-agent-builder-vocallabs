import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { actionBody, methodGuard, sendError, userIdFrom, verifyInternalWebhook } from "../_lib/http";
import { createWorkflowRun } from "../_lib/workflow-service";

interface TriggerInput {
  workflow_id: string;
  input?: Record<string, unknown> | null;
  client_request_id?: string | null;
}

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const payload = actionBody<TriggerInput>(req);
    const userId = userIdFrom(payload);
    const result = await createWorkflowRun({
      workflowId: payload.input.workflow_id,
      triggerType: "manual",
      input: payload.input.input ?? {},
      idempotencyKey: `manual:${payload.input.client_request_id ?? randomUUID()}`,
      userId,
      requireInteractiveRole: true,
    });
    return res.status(200).json({ run_id: result.runId, status: result.status, message: "Run queued" });
  } catch (error) {
    return sendError(res, error);
  }
}
