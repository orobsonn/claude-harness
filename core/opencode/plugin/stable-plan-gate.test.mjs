/** @description Downstream dispatches consume the stable plan without binding or prompt mutation. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PlanGate } from "./plan-gate.ts";

const { createPlanGateHooks } = PlanGate.testApi;
const SESSION = "ses_stable_gate";
const FEATURE = "stable-plan-gate";

function validPlan(overrides = {}) {
  return {
    feature_id: FEATURE,
    mode: "light",
    model_strategy: {
      hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" },
      planner: "openai/gpt-5.6-sol",
      "plan-reviewer": "openai/gpt-5.6-sol",
      compliance: "openai/gpt-5.6-sol",
      adversary: "openai/gpt-5.6-sol",
      security: "openai/gpt-5.6-sol",
      harvester: "openai/gpt-5.6-luna",
      shipper: "openai/gpt-5.6-luna",
    },
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks: [{
      id: "task-1",
      title: "Implement stable plan",
      description: "Consume the stable plan directly.",
      depends_on: [],
      severity: "medium",
      complexity: "medium",
      scope_paths: ["src/a.ts"],
      resolved_judgments: { plan_path: "stable" },
      criterion_refs: ["#ac-1"],
      locked_tests: [{ id: "lt-1", path: "tests/a.test.mjs", assertion: "Given a stable plan, When dispatched, Then scope is fixed" }],
      adversarial: { enabled: false, focus: [] },
    }],
    ...overrides,
  };
}

function fixture(plan = validPlan(), state = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stable-plan-gate-"));
  const statePath = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
  const planPath = path.join(root, ".opencode", "plans", FEATURE, "execution-plan.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    session_id: SESSION,
    feature_id: FEATURE,
    mode: "LIGHT",
    classified: true,
    ...state,
  }));
  if (plan !== null) fs.writeFileSync(planPath, JSON.stringify(plan));
  return { root, planPath, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function dispatch(root, { role = "executor-low", prompt, featureId, taskId } = {}) {
  const hooks = await createPlanGateHooks(root);
  const actualPrompt = prompt ?? '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]\nImplement.';
  const output = { args: {
    subagent_type: role,
    prompt: actualPrompt,
    ...(featureId === undefined ? {} : { feature_id: featureId }),
    ...(taskId === undefined ? {} : { taskId }),
  } };
  await hooks["tool.execute.before"]({ tool: "task", sessionID: SESSION }, output);
  return output.args.prompt;
}

test("valid stable plan permits downstream dispatch without planner binding and preserves prompt bytes", async () => {
  const f = fixture();
  try {
    const prompt = '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]\r\nKeep exactly.\n';
    assert.equal(await dispatch(f.root, { prompt }), prompt);
    assert.equal(await dispatch(f.root, { role: "plan-reviewer", prompt: "Review exactly this." }), "Review exactly this.");
  } finally { f.close(); }
});

test("missing or structurally invalid stable plan denies every guarded dispatch", async () => {
  for (const plan of [null, { feature_id: FEATURE, mode: "light", tasks: [] }]) {
    const f = fixture(plan);
    try {
      await assert.rejects(() => dispatch(f.root), /plan-gate.*(?:missing|validatePlan|full plan)/i);
    } finally { f.close(); }
  }
});

test("stable plan feature, mode, and task must match the classified dispatch", async () => {
  for (const [label, plan, args] of [
    ["feature", validPlan({ feature_id: "other-feature" }), {}],
    ["mode", validPlan({ mode: "full" }), {}],
    ["task", validPlan(), { taskId: "missing-task" }],
  ]) {
    const f = fixture(plan);
    try {
      await assert.rejects(() => dispatch(f.root, args), new RegExp(label, "i"));
    } finally { f.close(); }
  }
});
