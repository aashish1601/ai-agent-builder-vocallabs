import type { Request, Response } from "express";
import type { HasuraActionPayload } from "./types";

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "bad-request",
  ) {
    super(message);
  }
}

export function actionBody<T>(req: Request): HasuraActionPayload<T> {
  if (!req.body || typeof req.body !== "object") {
    throw new HttpError("Invalid request payload", 400);
  }
  return req.body as HasuraActionPayload<T>;
}

export function userIdFrom(payload: HasuraActionPayload<unknown>): string {
  const userId = payload.session_variables?.["x-hasura-user-id"];
  if (!userId) throw new HttpError("Authentication required", 401, "unauthenticated");
  return userId;
}

export function verifyInternalWebhook(req: Request): void {
  const expected = process.env.NHOST_WEBHOOK_SECRET;
  if (!expected) return;
  const actual = req.header("x-nhost-webhook-secret") ?? req.header("x-workflow-secret");
  if (actual !== expected) throw new HttpError("Invalid webhook signature", 401, "invalid-webhook");
}

export function sendError(res: Response, error: unknown) {
  const known = error instanceof HttpError;
  const status = known ? error.status : 500;
  const message = known
    ? error.message
    : error instanceof Error
      ? `Workflow service failure: ${error.message}`
      : "The workflow service could not complete the request";
  if (!known) console.error(error);
  return res.status(status).json({
    message,
    extensions: { code: known ? error.code : "internal-error" },
  });
}

export function methodGuard(req: Request, res: Response): boolean {
  if (req.method === "POST") return true;
  res.setHeader("Allow", "POST");
  res.status(405).json({ message: "Method not allowed" });
  return false;
}
