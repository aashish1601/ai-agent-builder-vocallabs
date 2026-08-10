import type { Request, Response } from "express";
import { actionBody, methodGuard, sendError, userIdFrom, verifyInternalWebhook } from "../_lib/http";
import { approvePausedStep } from "../_lib/workflow-service";

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const payload = actionBody<{ step_run_id: string }>(req);
    const userId = userIdFrom(payload);
    const result = await approvePausedStep(payload.input.step_run_id, userId);
    return res.status(200).json({ run_id: result.runId, status: result.status, message: "Step approved" });
  } catch (error) {
    return sendError(res, error);
  }
}
