import type { Request, Response } from "express";
import { methodGuard, sendError, verifyInternalWebhook } from "../_lib/http";
import { processWorkflowJob } from "../_lib/executor";
import type { HasuraEventPayload } from "../_lib/types";

interface JobRow { id: string }

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const event = req.body as HasuraEventPayload<JobRow>;
    const jobId = event.event?.data?.new?.id;
    if (!jobId) throw new Error("Event did not contain a workflow job");
    const result = await processWorkflowJob(jobId);
    return res.status(200).json(result);
  } catch (error) {
    return sendError(res, error);
  }
}
