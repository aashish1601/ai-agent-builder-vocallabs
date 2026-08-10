# AgentForge — AI Agent Workflow Builder

AgentForge is a multi-tenant AI workflow operations platform built for the VocalLabs full-stack assignment. Organizations can compose AI, HTTP, branching, database, notification, and approval steps; start workflows manually or from webhooks, schedules, and database events; and watch every state change through a Hasura subscription.

## Submission links

- GitHub: [github.com/aashish1601/ai-agent-builder-vocallabs](https://github.com/aashish1601/ai-agent-builder-vocallabs)
- Live app: [ai-agent-builder-vocallabs.vercel.app](https://ai-agent-builder-vocallabs.vercel.app/)
- Demo recording: [Google Drive video](https://drive.google.com/file/d/10Bxxg7AVgICUKjcCqTlzJFsH5XxoR0Sq/view?usp=sharing)

## Assignment coverage

| Requirement | Implementation |
|---|---|
| Nhost + PostgreSQL + Hasura | Versioned SQL in `nhost/migrations`, metadata in `nhost/metadata` |
| Six step types | `llm_call`, `http_request`, `conditional_branch`, `approval_gate`, safe `db_write`, Event Trigger-backed `notify` |
| Four trigger types | Manual Action, public webhook Action with hashed secret, one-minute scheduled dispatcher, database Event Trigger |
| Tenant isolation | Hasura row filters traverse `organization.members` and `X-Hasura-User-Id` on every exposed table/view |
| Role rules | `org_members.role`; owner/editor/viewer are deliberately not global JWT roles |
| Dangerous operations | Owner-only metadata checks plus `saveWorkflow` handler checks for `db_write`, `notify`, and webhook changes |
| Approval security | `approveStep` locks the run and checks owner/editor membership in the run's organization |
| Durable execution | Immutable `step_runs` snapshots and an idempotent, Event Trigger-driven `workflow_jobs` queue |
| Retry/failure handling | LLM and HTTP steps attempt twice; Hasura delivery retries are configured independently |
| Quota | Atomic `quota_reserved` check at start; converted to `quota_used` at terminal completion |
| Aggregation | Tracked `organization_usage_monthly` PostgreSQL view |
| Live status | `workflow_runs_by_pk` GraphQL subscription over WebSocket |
| Frontend | Next.js 16 workflow builder, run timeline, approval UI, quota, members and activity pages |

## Architecture

```text
Next.js / Nhost Auth
        │
        ▼
Hasura GraphQL ─── row + column permissions
        │
        ├── saveWorkflow Action
        ├── triggerWorkflowRun Action
        ├── triggerWorkflowWebhook Action
        └── approveStep Action
                  │
                  ▼
       PostgreSQL run + step snapshots
                  │
                  ▼
         workflow_jobs INSERT
                  │ Hasura Event Trigger
                  ▼
       Nhost function executes one step
                  │
                  ├── pause at approval_gate
                  ├── queue next step
                  └── finish/fail + finalize quota
```

Each Action is short-lived. Execution is not tied to the original HTTP request. A job event executes one step and inserts the next job. Hasura provides at-least-once event delivery, so job rows and side-effect records have uniqueness constraints and the runner claims a lease before executing.

See [docs/architecture.md](docs/architecture.md) for the schema and security reasoning.

## Local setup

### Requirements

- Node.js 22
- npm 11+
- Git
- Docker
- Nhost CLI
- On Windows, run Nhost inside WSL2

### 1. Install the application

```bash
npm install
cp .env.example .env.local
cp .secrets.example .secrets
```

### 2. Start Nhost

```bash
nhost init        # only when starting outside this already initialized repository
nhost up
```

The checked-in migration and metadata create all schema objects, relationships, permissions, Actions, Event Triggers, and the cron dispatcher.

Set `DATABASE_URL` for the Functions runtime. In Nhost Cloud, copy the project PostgreSQL connection string into a project secret named `DATABASE_URL`. Never expose this value to Next.js.

### 3. Configure the frontend

Use the values printed by `nhost up`:

```env
NEXT_PUBLIC_NHOST_SUBDOMAIN=local
NEXT_PUBLIC_NHOST_REGION=local
NEXT_PUBLIC_NHOST_GRAPHQL_URL=https://local.graphql.local.nhost.run/v1
NEXT_PUBLIC_NHOST_AUTH_URL=https://local.auth.local.nhost.run/v1
NEXT_PUBLIC_NHOST_FUNCTIONS_URL=https://local.functions.local.nhost.run/v1
NEXT_PUBLIC_DEMO_MODE=false
```

### 4. Seed the two-organization scenario

Disable mandatory email verification for the local project, then run:

```bash
DATABASE_URL="postgres://postgres:postgres@localhost:5432/local" \
NHOST_AUTH_URL="https://local.auth.local.nhost.run/v1" \
npm run seed:demo
```

Demo accounts use the password `AgentForge!2026` unless `DEMO_PASSWORD` is set:

| Account | Organization | Role |
|---|---|---|
| `owner-a@agentforge.demo` | Northstar Operations | owner |
| `editor-a@agentforge.demo` | Northstar Operations | editor |
| `viewer-a@agentforge.demo` | Northstar Operations | viewer |
| `owner-b@agentforge.demo` | Atlas Commerce | owner |

The seeded webhook secret is `northstar-demo-webhook-secret`. It is development data only.

### 5. Run Next.js

```bash
npm run dev
```

Open `http://localhost:3000`.

### Frontend-only preview

If Docker/Nhost is not available, set `NEXT_PUBLIC_DEMO_MODE=true`. This enables an explicitly labelled in-browser product preview, including a simulated approval continuation. It is not a substitute for the Hasura integration demonstration.

## LLM and notifications

Add `GROQ_API_KEY` to Nhost project secrets for a real LLM call. `GROQ_MODEL` defaults to `llama-3.1-8b-instant`. Without a key, the runner uses a disclosed deterministic stub with a 900 ms delay.

For Slack, add `SLACK_WEBHOOK_URL`. Without it, the notification Event Trigger waits 450 ms, logs the payload, and marks it delivered as a disclosed demo transport.

## Webhook invocation

External systems call the public Hasura Action—not the Function URL directly:

```graphql
mutation StartFromWebhook {
  triggerWorkflowWebhook(
    workflow_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    secret: "northstar-demo-webhook-secret"
    event_id: "crm-event-1001"
    payload: { message: "Please approve this urgent customer issue" }
  ) {
    run_id
    status
  }
}
```

The raw secret is shown once when a webhook trigger is created; only its SHA-256 digest is stored.

## Verification

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

### Runtime isolation test

After creating a paused Org A run, provide real JWTs and IDs:

```bash
NHOST_GRAPHQL_URL="https://<project>.graphql.<region>.nhost.run/v1" \
SECURITY_ORG_A_WORKFLOW_ID="<uuid>" \
SECURITY_ORG_A_PAUSED_STEP_ID="<uuid>" \
SECURITY_ORG_A_OWNER_TOKEN="<jwt>" \
SECURITY_ORG_A_VIEWER_TOKEN="<jwt>" \
SECURITY_ORG_B_OWNER_TOKEN="<jwt>" \
npm run test:security
```

It proves Org A can read its workflow while Org B cannot read, trigger, or approve it by guessed ID, and an Org A viewer cannot trigger it.

## Deploy

### Nhost

1. Create an Nhost project.
2. Link it with `nhost link`.
3. Add `DATABASE_URL`, `GROQ_API_KEY`, and optional `SLACK_WEBHOOK_URL` secrets.
4. Connect the GitHub repository to Nhost or deploy from the Nhost CLI.
5. Apply the seed only to a controlled demonstration project.

### Vercel

1. Import the same GitHub repository.
2. Add `NEXT_PUBLIC_NHOST_SUBDOMAIN` and `NEXT_PUBLIC_NHOST_REGION`.
3. Leave `NEXT_PUBLIC_DEMO_MODE=false`.
4. Deploy and add the Vercel domain to Nhost Auth's allowed client/redirect URLs.

## Important security properties

- The admin secret and database URL exist only in backend services.
- Action Function URLs verify `NHOST_WEBHOOK_SECRET`; clients cannot forge `session_variables` by calling Functions directly.
- HTTP steps allow HTTPS only, reject credentials and private/loopback DNS results, strip sensitive headers, limit response size, and set timeouts.
- `db_write` writes only to `workflow_artifacts`; it never accepts SQL or table names.
- Workflow definitions are snapshotted so edits cannot alter a running execution.
- Approval and quota changes use row locks.
- Public webhook failures return a generic not-found response to avoid resource enumeration.
- Arbitrary external side effects are at-least-once. `Idempotency-Key: <step_run_id>` is sent where supported.

## Repository map

```text
functions/                 Nhost Actions, Event Trigger and cron handlers
nhost/migrations/          PostgreSQL schema and aggregation view
nhost/metadata/            Hasura tables, permissions, Actions and triggers
scripts/seed-demo.ts       Two-organization demonstration seed
src/app/                   Next.js routes
src/components/            Auth, organization shell, builder and run monitor
tests/                     Validation, metadata and runtime isolation tests
docs/                      Architecture write-up and recording script
```
