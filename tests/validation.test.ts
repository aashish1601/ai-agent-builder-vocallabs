import { describe, expect, it } from "vitest";
import { validateWorkflow } from "../functions/_lib/validation";

const base = {
  organization_id: "11111111-1111-4111-8111-111111111111",
  name: "Secure workflow",
  enabled: true,
  triggers: [{ type: "manual", enabled: true, config: {} }],
};

describe("workflow definition validation", () => {
  it("accepts a typed branch and approval path", () => {
    const workflow = validateWorkflow({
      ...base,
      steps: [
        { step_key: "classify", name: "Classify", type: "llm_call", next_step_key: "branch", config: { prompt_template: "{{run.input.message}}", response_format: "json" } },
        { step_key: "branch", name: "Branch", type: "conditional_branch", config: { source_step_key: "classify", path: "decision", operator: "eq", value: "approve", true_next_key: "approval", false_next_key: "approval" } },
        { step_key: "approval", name: "Approve", type: "approval_gate", config: { message: "Approve this" } },
      ],
    });
    expect(workflow.steps).toHaveLength(3);
  });

  it("rejects cycles", () => {
    expect(() => validateWorkflow({
      ...base,
      steps: [
        { step_key: "first", name: "First", type: "approval_gate", next_step_key: "second", config: { message: "A" } },
        { step_key: "second", name: "Second", type: "approval_gate", next_step_key: "first", config: { message: "B" } },
      ],
    })).toThrow(/cycles/i);
  });

  it("rejects unknown branch targets", () => {
    expect(() => validateWorkflow({
      ...base,
      steps: [{ step_key: "branch", name: "Branch", type: "conditional_branch", config: { source_step_key: "missing", path: "decision", operator: "eq", value: true, true_next_key: "missing", false_next_key: "missing" } }],
    })).toThrow(/unknown step/i);
  });
});
