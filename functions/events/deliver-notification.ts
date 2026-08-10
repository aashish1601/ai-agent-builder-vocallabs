import type { Request, Response } from "express";
import { pool } from "../_lib/db";
import { methodGuard, sendError, verifyInternalWebhook } from "../_lib/http";
import type { HasuraEventPayload } from "../_lib/types";

interface NotificationRow {
  id: string;
  channel: "slack" | "email" | "demo";
  destination: string | null;
  payload: { message?: string };
  status: string;
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export default async function handler(req: Request, res: Response) {
  if (!methodGuard(req, res)) return;
  try {
    verifyInternalWebhook(req);
    const event = req.body as HasuraEventPayload<NotificationRow>;
    const notification = event.event?.data?.new;
    if (!notification) throw new Error("Missing notification row");
    if (notification.status === "delivered") return res.status(200).json({ status: "already-delivered" });

    if (notification.channel === "slack" && process.env.SLACK_WEBHOOK_URL) {
      const response = await fetch(process.env.SLACK_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: notification.payload.message ?? "Workflow notification" }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new Error(`Slack returned ${response.status}`);
    } else {
      // Disclosed demo transport used when Slack/email credentials are not configured.
      await wait(450);
      console.info("Demo notification", notification.id, notification.payload);
    }

    await pool.query(
      `UPDATE public.notification_outbox
          SET status = 'delivered', attempts = attempts + 1, delivered_at = now(), error = NULL
        WHERE id = $1`,
      [notification.id],
    );
    return res.status(200).json({ status: "delivered" });
  } catch (error) {
    const notificationId = (req.body as HasuraEventPayload<NotificationRow>)?.event?.data?.new?.id;
    if (notificationId) {
      await pool.query(
        `UPDATE public.notification_outbox
            SET status = 'failed', attempts = attempts + 1, error = $2
          WHERE id = $1`,
        [notificationId, error instanceof Error ? error.message.slice(0, 2_000) : String(error)],
      ).catch(console.error);
    }
    return sendError(res, error);
  }
}
