import type { Request, Response } from "express";
import { transaction } from "../_lib/db";
import { methodGuard, sendError, verifyInternalWebhook } from "../_lib/http";
import { createWorkflowRun } from "../_lib/workflow-service";

interface DueTrigger {
  id: string;
  workflow_id: string;
  config: Record<string, unknown>;
  scheduled_for: string;
}

async function claimDueTriggers() {
  return transaction(async (client) => {
    const result = await client.query<DueTrigger>(
      `SELECT id, workflow_id, config, next_run_at::text AS scheduled_for
         FROM public.workflow_triggers
        WHERE type = 'scheduled' AND enabled AND next_run_at <= now()
        ORDER BY next_run_at
        FOR UPDATE SKIP LOCKED
        LIMIT 25`,
    );
    for (const trigger of result.rows) {
      const interval = Math.max(1, Number(trigger.config.interval_minutes ?? 60));
      await client.query(
        `UPDATE public.workflow_triggers
            SET next_run_at = GREATEST(next_run_at, now()) + ($2::text || ' minutes')::interval
          WHERE id = $1`,
        [trigger.id, interval],
      );
    }
    return result.rows;
  });
}

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const due = await claimDueTriggers();
    const dispatched = [];
    for (const trigger of due) {
      const run = await createWorkflowRun({
        workflowId: trigger.workflow_id,
        triggerId: trigger.id,
        triggerType: "scheduled",
        input: { scheduled_for: trigger.scheduled_for },
        idempotencyKey: `scheduled:${trigger.id}:${trigger.scheduled_for}`,
      });
      dispatched.push(run.runId);
    }
    return res.status(200).json({ dispatched: dispatched.length, run_ids: dispatched });
  } catch (error) {
    return sendError(res, error);
  }
}
