export type OrgRole = "owner" | "editor" | "viewer";
export type StepType =
  | "llm_call"
  | "http_request"
  | "db_write"
  | "notify"
  | "conditional_branch"
  | "approval_gate";
export type TriggerType = "manual" | "webhook" | "scheduled" | "database_event";

export interface HasuraActionPayload<T> {
  action: { name: string };
  input: T;
  session_variables?: Record<string, string>;
  request_query?: string;
}

export interface HasuraEventPayload<T> {
  id: string;
  created_at: string;
  event: {
    op: "INSERT" | "UPDATE" | "DELETE" | "MANUAL";
    data: { old: T | null; new: T | null };
    session_variables?: Record<string, string>;
  };
  delivery_info?: { current_retry: number; max_retries: number };
  trigger?: { name: string };
}

export interface StepInput {
  id?: string;
  step_key: string;
  name: string;
  type: StepType;
  config: Record<string, unknown>;
  next_step_key?: string | null;
}

export interface TriggerInput {
  id?: string;
  type: TriggerType;
  enabled?: boolean;
  config: Record<string, unknown>;
}

export interface WorkflowSpec {
  workflow_id?: string | null;
  organization_id: string;
  name: string;
  description?: string;
  enabled?: boolean;
  steps: StepInput[];
  triggers: TriggerInput[];
}

export interface ActionResult {
  run_id?: string;
  workflow_id?: string;
  status: string;
  message?: string;
  webhook_secret?: string | null;
}
