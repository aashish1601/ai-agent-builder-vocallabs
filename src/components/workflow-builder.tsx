"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowDown, ArrowLeft, ArrowUp, Bot, Braces, Check, ChevronRight, CircleStop, Clock3, Code2, Database, GitBranch, Globe2, KeyRound, Loader2, LockKeyhole, Mail, Play, Plus, Save, Send, ShieldCheck, Trash2, Webhook, X } from "lucide-react";
import { useOrganization } from "./org-shell";
import { graphql } from "@/lib/graphql";
import { demoMode } from "@/lib/nhost";

type StepType = "llm_call" | "http_request" | "conditional_branch" | "approval_gate" | "db_write" | "notify";
type TriggerType = "manual" | "webhook" | "scheduled" | "database_event";
interface BuilderStep { id?: string; step_key: string; name: string; type: StepType; config: Record<string, unknown>; next_step_key: string | null }
interface BuilderTrigger { id?: string; type: TriggerType; enabled: boolean; config: Record<string, unknown> }

const STEP_TYPES: Array<{ type: StepType; label: string; description: string; ownerOnly?: boolean; icon: typeof Bot; tone: string }> = [
  { type: "llm_call", label: "LLM call", description: "Generate structured AI output", icon: Bot, tone: "violet" },
  { type: "http_request", label: "HTTP request", description: "Call an external HTTPS API", icon: Globe2, tone: "blue" },
  { type: "conditional_branch", label: "Conditional branch", description: "Route using previous output", icon: GitBranch, tone: "amber" },
  { type: "approval_gate", label: "Approval gate", description: "Pause for a human decision", icon: ShieldCheck, tone: "teal" },
  { type: "db_write", label: "Database write", description: "Save a workflow artifact", ownerOnly: true, icon: Database, tone: "rose" },
  { type: "notify", label: "Notification", description: "Queue Slack or email delivery", ownerOnly: true, icon: Mail, tone: "green" },
];

const defaultSteps: BuilderStep[] = [
  { step_key: "classify_request", name: "Classify request", type: "llm_call", next_step_key: "check_decision", config: { system_prompt: "Return JSON with decision and summary fields.", prompt_template: "Classify this request: {{run.input.message}}. Use decision approve or reject.", response_format: "json" } },
  { step_key: "check_decision", name: "Check AI decision", type: "conditional_branch", next_step_key: null, config: { source_step_key: "classify_request", path: "decision", operator: "eq", value: "approve", true_next_key: "enrich_request", false_next_key: "human_approval" } },
  { step_key: "enrich_request", name: "Enrich request", type: "http_request", next_step_key: "human_approval", config: { method: "GET", url: "https://jsonplaceholder.typicode.com/todos/1", headers: {}, timeout_ms: 8000 } },
  { step_key: "human_approval", name: "Operations approval", type: "approval_gate", next_step_key: null, config: { message: "Review the AI decision and enriched request before continuing." } },
];

const defaultTriggers: BuilderTrigger[] = [{ type: "manual", enabled: true, config: {} }];

export function WorkflowBuilder({ organizationId, workflowId }: { organizationId: string; workflowId?: string }) {
  const router = useRouter();
  const { role } = useOrganization();
  const readOnly = role === "viewer";
  const [name, setName] = useState(workflowId ? "Loading workflow…" : "Untitled AI workflow");
  const [description, setDescription] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [steps, setSteps] = useState<BuilderStep[]>(defaultSteps);
  const [triggers, setTriggers] = useState<BuilderTrigger[]>(defaultTriggers);
  const [selectedKey, setSelectedKey] = useState(defaultSteps[0].step_key);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [savedId, setSavedId] = useState(workflowId);
  const [toast, setToast] = useState<string | null>(null);
  const [webhookSecret, setWebhookSecret] = useState<string | null>(null);

  useEffect(() => {
    if (!workflowId) return;
    if (demoMode) {
      setName("AI support triage");
      setDescription("Classify inbound issues, enrich them, and pause before escalation.");
      setSteps([...defaultSteps, { step_key: "notify_support", name: "Notify support", type: "notify", next_step_key: null, config: { channel: "demo", message_template: "Approved: {{steps.classify_request.output.summary}}" } }]);
      setTriggers([{ id: "t1", type: "manual", enabled: true, config: {} }, { id: "t2", type: "webhook", enabled: true, config: {} }]);
      return;
    }
    graphql<{ workflows_by_pk: { name: string; description: string; enabled: boolean; steps: BuilderStep[]; triggers: BuilderTrigger[] } | null }>(`query WorkflowEditor($id: uuid!) {
      workflows_by_pk(id: $id) {
        name description enabled
        steps(order_by: {position: asc}) { id step_key name type config next_step_key }
        triggers { id type enabled config }
      }
    }`, { id: workflowId }).then(({ workflows_by_pk }) => {
      if (!workflows_by_pk) { router.replace(`/org/${organizationId}/workflows`); return; }
      setName(workflows_by_pk.name); setDescription(workflows_by_pk.description); setEnabled(workflows_by_pk.enabled);
      setSteps(workflows_by_pk.steps); setTriggers(workflows_by_pk.triggers);
      setSelectedKey(workflows_by_pk.steps[0]?.step_key ?? "");
    });
  }, [workflowId, organizationId, router]);

  const selected = steps.find((step) => step.step_key === selectedKey) ?? null;
  const stepKeys = useMemo(() => steps.map((step) => step.step_key), [steps]);

  function addStep(type: StepType) {
    const definition = STEP_TYPES.find((item) => item.type === type)!;
    if (definition.ownerOnly && role !== "owner") return;
    const key = `${type.replace("_call", "")}_${crypto.randomUUID().slice(0, 6)}`;
    const config: Record<string, unknown> = type === "llm_call"
      ? { prompt_template: "Process: {{run.input.message}}", system_prompt: "Return concise JSON.", response_format: "json" }
      : type === "http_request" ? { method: "GET", url: "https://jsonplaceholder.typicode.com/todos/1", headers: {}, timeout_ms: 8000 }
      : type === "conditional_branch" ? { source_step_key: steps[0]?.step_key ?? key, path: "decision", operator: "eq", value: "approve", true_next_key: steps[0]?.step_key ?? key, false_next_key: steps[0]?.step_key ?? key }
      : type === "approval_gate" ? { message: "Review this workflow before it continues." }
      : type === "db_write" ? { key_template: "workflow-result", value_template: "{{steps.classify_request.output}}" }
      : { channel: "demo", message_template: "Workflow {{run.id}} completed." };
    const next = { step_key: key, name: definition.label, type, config, next_step_key: null };
    setSteps((items) => [...items, next]); setSelectedKey(key); setPaletteOpen(false);
  }

  function updateSelected(patch: Partial<BuilderStep>) {
    setSteps((items) => items.map((step) => step.step_key === selectedKey ? { ...step, ...patch } : step));
  }
  function updateConfig(key: string, value: unknown) {
    if (!selected) return;
    updateSelected({ config: { ...selected.config, [key]: value } });
  }
  function moveStep(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= steps.length) return;
    const next = [...steps]; [next[index], next[target]] = [next[target], next[index]]; setSteps(next);
  }
  function deleteSelected() {
    if (!selected) return;
    const remaining = steps.filter((step) => step.step_key !== selected.step_key);
    setSteps(remaining); setSelectedKey(remaining[0]?.step_key ?? "");
  }

  function toggleTrigger(type: TriggerType) {
    const existing = triggers.find((item) => item.type === type);
    if (existing) setTriggers((items) => items.filter((item) => item.type !== type));
    else setTriggers((items) => [...items, { type, enabled: true, config: type === "scheduled" ? { interval_minutes: 15 } : {} }]);
  }

  async function save() {
    if (readOnly || !steps.length) return savedId;
    setSaving(true); setToast(null);
    try {
      if (demoMode) {
        await new Promise((resolve) => setTimeout(resolve, 700));
        const id = savedId ?? crypto.randomUUID(); setSavedId(id); setToast("Workflow saved in demo mode"); return id;
      }
      const data = await graphql<{ saveWorkflow: { workflow_id: string; webhook_secret: string | null } }>(`mutation SaveWorkflow($spec: WorkflowSpecInput!) {
        saveWorkflow(spec: $spec) { workflow_id status webhook_secret }
      }`, { spec: { workflow_id: savedId ?? null, organization_id: organizationId, name, description, enabled, steps, triggers } });
      setSavedId(data.saveWorkflow.workflow_id);
      if (data.saveWorkflow.webhook_secret) setWebhookSecret(data.saveWorkflow.webhook_secret);
      setToast("Workflow saved securely");
      if (!workflowId) router.replace(`/org/${organizationId}/workflows/${data.saveWorkflow.workflow_id}`);
      return data.saveWorkflow.workflow_id;
    } finally { setSaving(false); setTimeout(() => setToast(null), 3500); }
  }

  async function run() {
    if (readOnly) return;
    setRunning(true);
    try {
      const id = await save(); if (!id) return;
      if (demoMode) { router.push(`/org/${organizationId}/runs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`); return; }
      const data = await graphql<{ triggerWorkflowRun: { run_id: string } }>(`mutation Run($workflowId: uuid!, $requestId: String!) {
        triggerWorkflowRun(workflow_id: $workflowId, input: {message: "Please classify and approve this high-priority request."}, client_request_id: $requestId) { run_id }
      }`, { workflowId: id, requestId: crypto.randomUUID() });
      router.push(`/org/${organizationId}/runs/${data.triggerWorkflowRun.run_id}`);
    } finally { setRunning(false); }
  }

  return (
    <div className="builder-page">
      <header className="builder-header">
        <div className="builder-title"><Link href={`/org/${organizationId}/workflows`} className="icon-button"><ArrowLeft /></Link><div><input disabled={readOnly} value={name} onChange={(event) => setName(event.target.value)} /><span><i className={enabled ? "on" : ""} />{enabled ? "Active" : "Draft"} · {steps.length} steps</span></div></div>
        <div className="builder-actions">{readOnly && <span className="readonly-badge"><LockKeyhole /> Viewer mode</span>}<button className="button button-secondary" disabled={readOnly || saving} onClick={save}>{saving ? <Loader2 className="spin" /> : <Save />} Save</button><button className="button button-primary" disabled={readOnly || running} onClick={run}>{running ? <Loader2 className="spin" /> : <Play />} Run workflow</button></div>
      </header>

      <div className="builder-grid">
        <section className="builder-canvas">
          <div className="canvas-heading"><div><span className="page-kicker">WORKFLOW DESIGN</span><h2>Execution path</h2></div><button className="button button-secondary button-small" disabled={readOnly} onClick={() => setPaletteOpen(true)}><Plus /> Add step</button></div>
          <div className="flow-stack">
            {steps.map((step, index) => <StepCard key={step.step_key} step={step} index={index} selected={selectedKey === step.step_key} total={steps.length} onSelect={() => setSelectedKey(step.step_key)} onMove={moveStep} readOnly={readOnly} />)}
            {!steps.length && <button className="empty-flow" onClick={() => setPaletteOpen(true)}><Plus /><strong>Add your first step</strong><span>Start with an AI call, HTTP request or approval.</span></button>}
          </div>
          <div className="trigger-panel"><div className="section-title"><div><span className="metric-icon small blue"><Webhook /></span><div><h3>Start this workflow</h3><p>Attach one or more trigger types.</p></div></div></div><div className="trigger-grid">
            {(["manual", "webhook", "scheduled", "database_event"] as TriggerType[]).map((type) => {
              const active = triggers.some((item) => item.type === type); const ownerOnly = type === "webhook"; const Icon = type === "manual" ? Play : type === "webhook" ? Webhook : type === "scheduled" ? Clock3 : Database;
              return <button disabled={readOnly || (ownerOnly && role !== "owner")} className={`trigger-option ${active ? "active" : ""}`} onClick={() => toggleTrigger(type)} key={type}><span><Icon /></span><div><strong>{type.replace("_", " ")}</strong><small>{ownerOnly && role !== "owner" ? "Owner only" : active ? "Enabled" : "Not attached"}</small></div><i>{active && <Check />}</i></button>;
            })}
          </div>{triggers.some((item) => item.type === "scheduled") && <label className="inline-field">Run every <input type="number" min="1" value={Number(triggers.find((item) => item.type === "scheduled")?.config.interval_minutes ?? 15)} onChange={(event) => setTriggers((items) => items.map((item) => item.type === "scheduled" ? { ...item, config: { interval_minutes: Number(event.target.value) } } : item))} /> minutes</label>}</div>
        </section>

        <aside className="inspector">
          {selected ? <StepInspector step={selected} steps={steps} readOnly={readOnly} onName={(value) => updateSelected({ name: value })} onNext={(value) => updateSelected({ next_step_key: value || null })} onConfig={updateConfig} onDelete={deleteSelected} /> : <div className="inspector-empty"><Code2 /><h3>Select a step</h3><p>Choose a workflow step to configure its behavior.</p></div>}
        </aside>
      </div>

      {paletteOpen && <div className="modal-backdrop" onMouseDown={() => setPaletteOpen(false)}><div className="step-palette" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="form-kicker">STEP LIBRARY</span><h2>Add an action</h2><p>Choose what should happen next in the workflow.</p></div><button className="icon-button" onClick={() => setPaletteOpen(false)}><X /></button></header><div className="palette-grid">{STEP_TYPES.map((definition) => <button key={definition.type} disabled={definition.ownerOnly && role !== "owner"} onClick={() => addStep(definition.type)}><span className={`step-icon ${definition.tone}`}><definition.icon /></span><div><strong>{definition.label}</strong><p>{definition.description}</p>{definition.ownerOnly && <small><KeyRound /> Owner only</small>}</div><ChevronRight /></button>)}</div></div></div>}
      {toast && <div className="toast"><Check />{toast}</div>}
      {webhookSecret && <div className="secret-banner"><AlertTriangle /><div><strong>Copy your webhook secret now</strong><p>It is stored only as a SHA-256 hash and will not be shown again.</p><code>{webhookSecret}</code></div><button onClick={() => { navigator.clipboard.writeText(webhookSecret); setToast("Secret copied"); }}>Copy</button><button className="icon-button" onClick={() => setWebhookSecret(null)}><X /></button></div>}
    </div>
  );
}

function StepCard({ step, index, selected, total, onSelect, onMove, readOnly }: { step: BuilderStep; index: number; selected: boolean; total: number; onSelect(): void; onMove(index: number, direction: -1 | 1): void; readOnly: boolean }) {
  const definition = STEP_TYPES.find((item) => item.type === step.type)!;
  return <div className="flow-card-wrap">{index > 0 && <div className="flow-connector"><span /></div>}<article onClick={onSelect} className={`flow-card ${selected ? "selected" : ""}`}><span className={`step-icon ${definition.tone}`}><definition.icon /></span><div className="flow-card-copy"><small>{definition.label}</small><strong>{step.name}</strong><p>{step.type === "llm_call" ? String(step.config.model ?? "Groq / configured model") : step.type === "http_request" ? String(step.config.method ?? "GET") + " · HTTPS endpoint" : step.type === "conditional_branch" ? `${String(step.config.operator)} → two paths` : step.type === "approval_gate" ? "Owner or editor approval" : definition.description}</p></div><div className="flow-card-tools"><span>{String(index + 1).padStart(2, "0")}</span>{!readOnly && <><button disabled={index === 0} onClick={(event) => { event.stopPropagation(); onMove(index, -1); }}><ArrowUp /></button><button disabled={index === total - 1} onClick={(event) => { event.stopPropagation(); onMove(index, 1); }}><ArrowDown /></button></>}</div></article></div>;
}

function StepInspector({ step, steps, readOnly, onName, onNext, onConfig, onDelete }: { step: BuilderStep; steps: BuilderStep[]; readOnly: boolean; onName(value: string): void; onNext(value: string): void; onConfig(key: string, value: unknown): void; onDelete(): void }) {
  const definition = STEP_TYPES.find((item) => item.type === step.type)!;
  const choices = steps.filter((item) => item.step_key !== step.step_key);
  return <div className="inspector-content"><header><span className={`step-icon ${definition.tone}`}><definition.icon /></span><div><small>STEP SETTINGS</small><h2>{definition.label}</h2></div></header><div className="inspector-form"><label>Step name<input disabled={readOnly} value={step.name} onChange={(event) => onName(event.target.value)} /></label><label>Step key<input disabled value={step.step_key} /></label>
    {step.type === "llm_call" && <><label>System prompt<textarea disabled={readOnly} value={String(step.config.system_prompt ?? "")} onChange={(event) => onConfig("system_prompt", event.target.value)} /></label><label>Prompt template<textarea className="code-input" disabled={readOnly} value={String(step.config.prompt_template ?? "")} onChange={(event) => onConfig("prompt_template", event.target.value)} /></label><label>Response format<select disabled={readOnly} value={String(step.config.response_format ?? "json")} onChange={(event) => onConfig("response_format", event.target.value)}><option value="json">Structured JSON</option><option value="text">Plain text</option></select></label></>}
    {step.type === "http_request" && <><div className="field-row"><label>Method<select disabled={readOnly} value={String(step.config.method ?? "GET")} onChange={(event) => onConfig("method", event.target.value)}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option></select></label><label>Timeout (ms)<input disabled={readOnly} type="number" value={Number(step.config.timeout_ms ?? 8000)} onChange={(event) => onConfig("timeout_ms", Number(event.target.value))} /></label></div><label>HTTPS URL<input disabled={readOnly} value={String(step.config.url ?? "")} onChange={(event) => onConfig("url", event.target.value)} /></label><p className="field-hint"><LockKeyhole /> Private networks and unsafe headers are blocked.</p></>}
    {step.type === "conditional_branch" && <><label>Source step<select disabled={readOnly} value={String(step.config.source_step_key ?? "")} onChange={(event) => onConfig("source_step_key", event.target.value)}>{choices.map((item) => <option key={item.step_key} value={item.step_key}>{item.name}</option>)}</select></label><label>Output path<input disabled={readOnly} value={String(step.config.path ?? "")} onChange={(event) => onConfig("path", event.target.value)} placeholder="decision" /></label><div className="field-row"><label>Operator<select disabled={readOnly} value={String(step.config.operator ?? "eq")} onChange={(event) => onConfig("operator", event.target.value)}><option value="eq">equals</option><option value="neq">not equal</option><option value="contains">contains</option><option value="exists">exists</option><option value="gt">greater than</option></select></label><label>Compare value<input disabled={readOnly} value={String(step.config.value ?? "")} onChange={(event) => onConfig("value", event.target.value)} /></label></div><label>True path<select disabled={readOnly} value={String(step.config.true_next_key ?? "")} onChange={(event) => onConfig("true_next_key", event.target.value)}>{choices.map((item) => <option key={item.step_key} value={item.step_key}>{item.name}</option>)}</select></label><label>False path<select disabled={readOnly} value={String(step.config.false_next_key ?? "")} onChange={(event) => onConfig("false_next_key", event.target.value)}>{choices.map((item) => <option key={item.step_key} value={item.step_key}>{item.name}</option>)}</select></label></>}
    {step.type === "approval_gate" && <><label>Approval message<textarea disabled={readOnly} value={String(step.config.message ?? "")} onChange={(event) => onConfig("message", event.target.value)} /></label><div className="permission-note"><ShieldCheck /><div><strong>Action-level permission</strong><p>The resume handler checks organization membership. Owners and editors can approve; viewers cannot.</p></div></div></>}
    {step.type === "db_write" && <><label>Artifact key<input disabled={readOnly} value={String(step.config.key_template ?? "")} onChange={(event) => onConfig("key_template", event.target.value)} /></label><label>Value template<textarea className="code-input" disabled={readOnly} value={typeof step.config.value_template === "string" ? step.config.value_template : JSON.stringify(step.config.value_template, null, 2)} onChange={(event) => onConfig("value_template", event.target.value)} /></label></>}
    {step.type === "notify" && <><label>Channel<select disabled={readOnly} value={String(step.config.channel ?? "demo")} onChange={(event) => onConfig("channel", event.target.value)}><option value="demo">Demo transport</option><option value="slack">Slack</option><option value="email">Email</option></select></label><label>Message template<textarea disabled={readOnly} value={String(step.config.message_template ?? "")} onChange={(event) => onConfig("message_template", event.target.value)} /></label><p className="field-hint"><Send /> Delivery is performed by a Hasura Event Trigger.</p></>}
    {step.type !== "conditional_branch" && <label>Next step<select disabled={readOnly} value={step.next_step_key ?? ""} onChange={(event) => onNext(event.target.value)}><option value="">Next by position / finish</option>{choices.map((item) => <option key={item.step_key} value={item.step_key}>{item.name}</option>)}</select></label>}
  </div>{!readOnly && <button className="danger-button" onClick={onDelete}><Trash2 />Delete step</button>}</div>;
}
