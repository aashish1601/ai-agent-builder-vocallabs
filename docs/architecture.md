# Architecture and security reasoning

## Schema

The organization is the tenant boundary. `org_members` relates an Nhost Auth user to an organization with an application-level role. Workflows belong to one organization and own ordered steps and triggers. A workflow execution creates one `workflow_run` and snapshots every editable step into `step_runs`; therefore an edit cannot change an in-flight or historical execution.

Execution is a durable state machine. `workflow_jobs` contains one unique job per step run. A Hasura Event Trigger invokes the Nhost runner whenever a job is inserted. The runner leases the job, executes one step, records its result, and inserts the next job. `approval_gate` records both the step and overall run as paused without inserting another job. `approveStep` resumes by inserting the continuation job.

`workflow_artifacts` is the only target of `db_write`, avoiding arbitrary SQL. `notification_outbox` separates workflow progress from Slack/email delivery and is consumed by its own Hasura Event Trigger. `workflow_signals` is a deliberately watched table for database-event starts. `organization_usage_monthly` is a tracked aggregate view.

## Permission layer 1: tenant and role scoping

All browser GraphQL requests use the global Nhost role `user`. Owner/editor/viewer are not JWT roles because one user may have a different role in each organization.

Hasura select permissions traverse database relationships from every exposed object back to `organization.members.user_id = X-Hasura-User-Id`. Mutation permissions add a role predicate. The same rule is present on workflows, definitions, triggers, runs, step runs, signals, artifacts, notifications, audit events, and the usage view. Therefore a direct primary-key query is still filtered by organization membership.

Owners manage members and all workflow definitions. Editors can edit ordinary steps and trigger runs. Viewers have select permissions only. Sensitive columns such as webhook hashes, job leases, idempotency keys, and internal counters are not exposed.

## Permission layer 2: step-level business decisions

Hasura metadata rejects an editor inserting or changing `db_write` and `notify`, and rejects webhook-trigger changes unless an owner membership exists. The `saveWorkflow` Action repeats this check against the complete before/after definition so the atomic mutation cannot bypass it. Existing owner-created restricted steps must remain byte-for-byte unchanged when an editor saves.

Approval cannot be expressed only as a row update permission because it is a mid-execution transition. `approveStep` locks the step and run, verifies that the caller is an owner/editor in that run's organization, records `approved_by/approved_at`, changes the run back to running, and queues exactly one continuation. Unauthorized and missing IDs return the same response.

## Quota and concurrency

Run creation locks the organization row and checks `quota_used + quota_reserved`. It reserves one unit before creating the run. This prevents concurrent requests from oversubscribing the quota. A terminal success or failure converts the reservation into used capacity. Failed runs count because they may already have consumed LLM/API resources.

## Reliability

LLM and HTTP steps retry once with backoff. Hasura Event Trigger delivery has a separate retry configuration. Jobs, artifacts, and notifications have uniqueness constraints for idempotent re-delivery. HTTP side effects are inherently at-least-once if a process dies after a remote service accepts a request; the runner sends `Idempotency-Key: step_run_id` so compatible services can deduplicate.

Step configuration is validated as a typed discriminated union. Branches support a restricted set of operators and never use `eval`. The graph is checked for missing references and cycles before saving.
