WITH deleted_run AS (
  DELETE FROM public.workflow_runs
  WHERE id = 'dd0e4cae-c0e7-4a88-b80d-6030cccf7544'::uuid
  RETURNING organization_id, status
)
UPDATE public.organizations AS organization
SET quota_reserved = GREATEST(organization.quota_reserved - 1, 0)
FROM deleted_run
WHERE organization.id = deleted_run.organization_id
  AND deleted_run.status IN ('queued', 'running', 'paused');
