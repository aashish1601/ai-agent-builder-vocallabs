import type { Request, Response } from "express";
import { pool } from "../_lib/db";
import { HttpError, methodGuard, sendError, verifyInternalWebhook } from "../_lib/http";
import type { HasuraEventPayload } from "../_lib/types";
import { createWorkflowRun } from "../_lib/workflow-service";

interface SignalRow {
  id: string;
  organization_id: string;
  workflow_trigger_id: string;
  payload: Record<string, unknown>;
  created_by: string | null;
}

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const event = req.body as HasuraEventPayload<SignalRow>;
    const signal = event.event?.data?.new;
    if (!signal) throw new HttpError("Missing signal row", 400);
    const triggerResult = await pool.query<{ id: string; workflow_id: string }>(
      `SELECT wt.id, wt.workflow_id
         FROM public.workflow_triggers wt
         JOIN public.workflows w ON w.id = wt.workflow_id
        WHERE wt.id = $1 AND wt.type = 'database_event' AND wt.enabled
          AND w.organization_id = $2`,
      [signal.workflow_trigger_id, signal.organization_id],
    );
    const trigger = triggerResult.rows[0];
    if (!trigger) throw new HttpError("Database trigger not found", 404, "not-found");
    const run = await createWorkflowRun({
      workflowId: trigger.workflow_id,
      triggerId: trigger.id,
      triggerType: "database_event",
      input: signal.payload ?? {},
      idempotencyKey: `database-event:${event.id}`,
      userId: signal.created_by,
    });
    return res.status(200).json({ run_id: run.runId, status: run.status });
  } catch (error) {
    return sendError(res, error);
  }
}
