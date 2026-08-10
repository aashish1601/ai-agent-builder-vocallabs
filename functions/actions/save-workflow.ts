import type { Request, Response } from "express";
import { actionBody, methodGuard, sendError, userIdFrom, verifyInternalWebhook } from "../_lib/http";
import { saveWorkflow } from "../_lib/workflow-service";
import { validateWorkflow } from "../_lib/validation";

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const payload = actionBody<{ spec: unknown }>(req);
    const userId = userIdFrom(payload);
    const spec = validateWorkflow(payload.input.spec);
    const result = await saveWorkflow(spec, userId);
    return res.status(200).json({
      workflow_id: result.workflowId,
      status: "saved",
      message: "Workflow saved",
      webhook_secret: result.webhookSecret,
    });
  } catch (error) {
    return sendError(res, error);
  }
}
