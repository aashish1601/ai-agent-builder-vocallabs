# Final scenario recording script

Target length: 4–6 minutes.

1. Sign in as `owner-a@agentforge.demo` and show Northstar's quota.
2. Open **AI support triage**. Briefly show the LLM, branch, HTTP, approval, database-write, and notification steps plus manual/webhook triggers.
3. Click **Run workflow**. Keep the run page visible while the subscription advances without refresh.
4. When paused, mention that no continuation job exists yet. Approve as the Org A owner or editor. Show the remaining steps finish and quota increase.
5. Open Hasura Event Trigger invocation logs to show the workflow-job and notification events.
6. Invoke `triggerWorkflowWebhook` from GraphiQL/Postman with a unique `event_id`. Open its returned run and show that it follows the same pipeline.
7. Sign in as `viewer-a@agentforge.demo`; show that Run and Approve controls are absent. Attempt `triggerWorkflowRun` in GraphiQL and show the denial.
8. Sign in as `owner-b@agentforge.demo`. Query Northstar's workflow UUID directly: it returns `null`. Attempt to trigger the workflow and approve the paused step UUID: both return the same not-found-style error.
9. End on the successful run timeline and repository migration/metadata folders.

Do not use the frontend-only demo mode for the submitted recording.
