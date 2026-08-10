CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  quota_allowed integer NOT NULL DEFAULT 100 CHECK (quota_allowed >= 0),
  quota_used integer NOT NULL DEFAULT 0 CHECK (quota_used >= 0),
  quota_reserved integer NOT NULL DEFAULT 0 CHECK (quota_reserved >= 0),
  quota_period_start date NOT NULL DEFAULT date_trunc('month', now())::date,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.org_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, user_id)
);

CREATE OR REPLACE FUNCTION public.protect_last_organization_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner') THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.org_members
       WHERE organization_id = OLD.organization_id
         AND role = 'owner'
         AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'An organization must retain at least one owner';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER protect_last_organization_owner
BEFORE DELETE OR UPDATE OF role ON public.org_members
FOR EACH ROW EXECUTE FUNCTION public.protect_last_organization_owner();

CREATE TABLE public.workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  description text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

CREATE TABLE public.workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  step_key text NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_]{1,63}$'),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  position integer NOT NULL CHECK (position >= 0),
  type text NOT NULL CHECK (type IN ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  next_step_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_id, step_key),
  UNIQUE (workflow_id, position),
  FOREIGN KEY (workflow_id, next_step_key)
    REFERENCES public.workflow_steps(workflow_id, step_key)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE public.workflow_triggers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('manual', 'webhook', 'scheduled', 'database_event')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  secret_hash text,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES public.workflows(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  trigger_id uuid REFERENCES public.workflow_triggers(id) ON DELETE SET NULL,
  trigger_type text NOT NULL CHECK (trigger_type IN ('manual', 'webhook', 'scheduled', 'database_event')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'paused', 'succeeded', 'failed', 'cancelled')),
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb,
  error text,
  current_step_key text,
  definition_version integer NOT NULL,
  idempotency_key text,
  started_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX workflow_runs_idempotency_unique
ON public.workflow_runs(workflow_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.step_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  source_step_id uuid REFERENCES public.workflow_steps(id) ON DELETE SET NULL,
  step_key text NOT NULL,
  name text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  type text NOT NULL CHECK (type IN ('llm_call', 'http_request', 'db_write', 'notify', 'conditional_branch', 'approval_gate')),
  config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  next_step_key text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'retrying', 'paused', 'succeeded', 'failed', 'skipped')),
  input jsonb,
  output jsonb,
  error text,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workflow_run_id, step_key),
  UNIQUE (workflow_run_id, position)
);

CREATE TABLE public.workflow_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id uuid NOT NULL UNIQUE REFERENCES public.step_runs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id uuid NOT NULL REFERENCES public.step_runs(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (length(key) BETWEEN 1 AND 120),
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (step_run_id, key)
);

CREATE TABLE public.notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  workflow_run_id uuid NOT NULL REFERENCES public.workflow_runs(id) ON DELETE CASCADE,
  step_run_id uuid NOT NULL UNIQUE REFERENCES public.step_runs(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('slack', 'email', 'demo')),
  destination text,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.workflow_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  workflow_trigger_id uuid NOT NULL REFERENCES public.workflow_triggers(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.audit_events (
  id bigserial PRIMARY KEY,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE CASCADE,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX org_members_user_idx ON public.org_members(user_id, organization_id);
CREATE INDEX workflows_org_idx ON public.workflows(organization_id, updated_at DESC);
CREATE INDEX workflow_steps_workflow_idx ON public.workflow_steps(workflow_id, position);
CREATE INDEX workflow_triggers_due_idx ON public.workflow_triggers(next_run_at) WHERE enabled;
CREATE INDEX workflow_runs_workflow_idx ON public.workflow_runs(workflow_id, created_at DESC);
CREATE INDEX workflow_runs_org_idx ON public.workflow_runs(organization_id, created_at DESC);
CREATE INDEX step_runs_run_idx ON public.step_runs(workflow_run_id, position);
CREATE INDEX workflow_jobs_queue_idx ON public.workflow_jobs(status, available_at);
CREATE INDEX notification_outbox_status_idx ON public.notification_outbox(status, created_at);
CREATE INDEX audit_events_org_idx ON public.audit_events(organization_id, created_at DESC);

CREATE TRIGGER organizations_updated_at BEFORE UPDATE ON public.organizations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER org_members_updated_at BEFORE UPDATE ON public.org_members
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflows_updated_at BEFORE UPDATE ON public.workflows
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflow_steps_updated_at BEFORE UPDATE ON public.workflow_steps
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflow_triggers_updated_at BEFORE UPDATE ON public.workflow_triggers
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflow_runs_updated_at BEFORE UPDATE ON public.workflow_runs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER step_runs_updated_at BEFORE UPDATE ON public.step_runs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER workflow_jobs_updated_at BEFORE UPDATE ON public.workflow_jobs
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER notification_outbox_updated_at BEFORE UPDATE ON public.notification_outbox
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE VIEW public.organization_usage_monthly AS
WITH run_totals AS (
  SELECT
    organization_id,
    date_trunc('month', COALESCE(completed_at, created_at)) AS month,
    count(*) FILTER (WHERE status IN ('succeeded', 'failed'))::integer AS completed_runs,
    count(*) FILTER (WHERE status = 'failed')::integer AS failed_runs,
    COALESCE(
      avg(EXTRACT(epoch FROM (completed_at - started_at)) * 1000)
        FILTER (WHERE completed_at IS NOT NULL AND started_at IS NOT NULL),
      0
    )::numeric(14,2) AS average_duration_ms
  FROM public.workflow_runs
  GROUP BY organization_id, date_trunc('month', COALESCE(completed_at, created_at))
), step_totals AS (
  SELECT
    wr.organization_id,
    date_trunc('month', COALESCE(wr.completed_at, wr.created_at)) AS month,
    count(sr.id) FILTER (WHERE sr.type = 'llm_call' AND sr.status = 'succeeded')::integer AS llm_calls
  FROM public.workflow_runs wr
  LEFT JOIN public.step_runs sr ON sr.workflow_run_id = wr.id
  GROUP BY wr.organization_id, date_trunc('month', COALESCE(wr.completed_at, wr.created_at))
)
SELECT
  rt.organization_id,
  rt.month,
  rt.completed_runs,
  rt.failed_runs,
  COALESCE(st.llm_calls, 0)::integer AS llm_calls,
  rt.average_duration_ms
FROM run_totals rt
LEFT JOIN step_totals st
  ON st.organization_id = rt.organization_id AND st.month = rt.month;

COMMENT ON VIEW public.organization_usage_monthly IS
'Hasura-tracked organization usage aggregate. Row access is scoped through organization membership metadata.';
