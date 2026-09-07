/**
 * @description Plan-gate da lane Pi: dispatch downstream só passa com plano estável válido.
 * Espelha core/opencode/plugin/stable-plan-gate.test.mjs (mesmos casos, mesmas mensagens),
 * trocando apenas a raiz de estado/planos para `.pi/harness/`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decidePiPlanGate, dispatchIds, isPlanGuardedRole } from "./plan-gate.mjs";

const SESSION = "ses-pi-stable-gate";
const FEATURE = "pi-plan-gate";
const MARKER = '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]\nImplement.';

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

/** @description Cria uma worktree temporária com gate-state e plano sob `.pi/harness/`. */
function fixture(plan = validPlan(), state = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-gate-"));
  const statePath = path.join(root, ".pi", "harness", "state", SESSION, "gate-state.json");
  const planPath = path.join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");
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

/** @description Executa a decisão como o adaptador `tool_call` faria. */
function dispatch(root, { role = "harness-executor", prompt = MARKER, sessionId = SESSION, extra = {} } = {}) {
  const input = { subagent_type: role, description: "d", prompt, complexity: "medium", ...extra };
  const decision = decidePiPlanGate({ projectRoot: root, sessionId, toolName: "subagent", input });
  return { decision, input };
}

test("plano estável válido permite o dispatch guardado e não muta o prompt", () => {
  const f = fixture();
  try {
    const { decision, input } = dispatch(f.root);
    assert.equal(decision.block, false);
    assert.equal(input.prompt, MARKER);

    const reviewer = dispatch(f.root, { role: "harness-plan-reviewer", prompt: "Review exactly this." });
    assert.equal(reviewer.decision.block, false);
    assert.equal(reviewer.input.prompt, "Review exactly this.");
  } finally { f.close(); }
});

test("dispatch de executor sem plano estável é negado", () => {
  const f = fixture(null);
  try {
    assert.deepEqual(dispatch(f.root).decision, {
      block: true,
      reason: "[plan-gate] denied: stable plan missing",
    });
  } finally { f.close(); }
});

test("a obrigação opcional de security deve ser boolean e preserva planos anteriores", () => {
  for (const security of [undefined, false, true, "true", null, 1]) {
    const f = fixture(validPlan({ final_review: { compliance: true, adversary: true, ...(security === undefined ? {} : { security }) } }));
    try {
      const decision = dispatch(f.root).decision;
      assert.equal(decision.block, security !== undefined && typeof security !== "boolean", String(security));
      if (decision.block) assert.match(decision.reason, /final_review.security.*boolean/i);
    } finally { f.close(); }
  }
});

test("plano stub e plano com tasks vazio são negados", () => {
  for (const [plan, pattern] of [
    [validPlan({ kind: "stub" }), /stub kind/],
    [validPlan({ tasks: [] }), /empty tasks/],
  ]) {
    const f = fixture(plan);
    try {
      const { decision } = dispatch(f.root);
      assert.equal(decision.block, true);
      assert.match(decision.reason, /^\[plan-gate\] Blocked:/);
      assert.match(decision.reason, pattern);
    } finally { f.close(); }
  }
});

test("plano ilegível ou não-objeto é negado com a reason canônica", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.planPath, "[]");
    assert.equal(dispatch(f.root).decision.reason, "[plan-gate] denied: stable plan invalid object");
    fs.writeFileSync(f.planPath, "{not json");
    assert.equal(dispatch(f.root).decision.reason, "[plan-gate] denied: stable plan unreadable");
  } finally { f.close(); }
});

test("feature e mode do plano precisam bater com a sessão classificada", () => {
  for (const [plan, reason] of [
    [validPlan({ feature_id: "other-feature" }), "[plan-gate] denied: stable plan feature mismatch"],
    [validPlan({ mode: "full" }), "[plan-gate] denied: stable plan mode mismatch (full != light)"],
  ]) {
    const f = fixture(plan);
    try {
      assert.equal(dispatch(f.root).decision.reason, reason);
    } finally { f.close(); }
  }
});

test("task_id inexistente no plano estável é negado", () => {
  const f = fixture();
  try {
    const prompt = '[HARNESS_TASK_CONTEXT]{"task_id":"task-404"}[/HARNESS_TASK_CONTEXT]\nGo.';
    assert.equal(
      dispatch(f.root, { prompt }).decision.reason,
      "[plan-gate] denied: dispatch task_id does not exist in stable plan",
    );
  } finally { f.close(); }
});

test("complexidade declarada da mão precisa ser a mesma da tarefa canônica", () => {
  const f = fixture();
  try {
    assert.equal(
      dispatch(f.root, { extra: { complexity: "high" } }).decision.reason,
      "[plan-gate] denied: dispatch complexity conflicts with stable plan task (high != medium)",
    );
    assert.equal(dispatch(f.root, { extra: { complexity: "medium" } }).decision.block, false);
  } finally { f.close(); }
});

test("mão sem marcador HARNESS_TASK_CONTEXT é negada; plan-reviewer não exige marcador", () => {
  const f = fixture();
  try {
    for (const role of ["harness-executor", "harness-sniper", "harness-test-author"]) {
      const { decision } = dispatch(f.root, { role, prompt: "Just do it." });
      assert.equal(decision.block, true);
      assert.match(decision.reason, /^\[plan-gate\] denied: [a-z-]+ task prompt must contain exactly one complete task marker$/);
    }
    assert.equal(dispatch(f.root, { role: "harness-plan-reviewer", prompt: "no marker" }).decision.block, false);
  } finally { f.close(); }
});

test("task_id dos args divergindo do marcador do brief é fail-closed antes de tocar disco", () => {
  const { decision } = dispatch("/pi-plan-gate/does/not/exist", { extra: { taskId: "task-9" } });
  assert.equal(
    decision.reason,
    "[plan-gate] denied: taskId dispatch args diverge from the brief's HARNESS_TASK_CONTEXT marker: task-9 != task-1",
  );
});

test("alias vazio não esconde o alias divergente logo atrás (paridade com aliasValues do OC)", () => {
  // No OC quem manda nas duas checagens é aliasValues (primeiro NÃO-VAZIO); um `taskId:""` na
  // frente de um `task` divergente não pode abrir a checagem anti-lavagem do marcador.
  const diverge = dispatch("/pi-plan-gate/does/not/exist", { extra: { taskId: "", task: "task-9" } });
  assert.equal(
    diverge.decision.reason,
    "[plan-gate] denied: taskId dispatch args diverge from the brief's HARNESS_TASK_CONTEXT marker: task-9 != task-1",
  );

  const f = fixture();
  try {
    assert.equal(
      dispatch(f.root, { extra: { feature_id: "", featureId: "other-feature" } }).decision.reason,
      "[plan-gate] denied: dispatch feature_id conflicts with stable plan feature",
    );
  } finally { f.close(); }
});

test("feature_id opcional do dispatch conflitando com o plano estável é negado", () => {
  const f = fixture();
  try {
    assert.equal(
      dispatch(f.root, { extra: { feature_id: "other-feature" } }).decision.reason,
      "[plan-gate] denied: dispatch feature_id conflicts with stable plan feature",
    );
    // Mesmo feature_id do plano não conflita.
    assert.equal(dispatch(f.root, { extra: { feature_id: FEATURE } }).decision.block, false);
  } finally { f.close(); }
});

test("identidade de sessão do runtime é obrigatória", () => {
  const f = fixture();
  try {
    for (const sessionId of ["", null, 42]) {
      assert.equal(
        dispatch(f.root, { sessionId }).decision.reason,
        "[plan-gate] denied: trusted session identity required",
      );
    }
    // sessionId ausente (ctx sem sessionManager) também é negado.
    assert.equal(
      decidePiPlanGate({
        projectRoot: f.root,
        toolName: "subagent",
        input: { subagent_type: "harness-executor", prompt: MARKER },
      }).reason,
      "[plan-gate] denied: trusted session identity required",
    );
  } finally { f.close(); }
});

test("gate-state ausente, ilegível ou não classificado nega o dispatch", () => {
  const f = fixture();
  try {
    assert.equal(
      dispatch(f.root, { sessionId: "ses-outra-sessao" }).decision.reason,
      "[plan-gate] denied: gate-state missing",
    );
  } finally { f.close(); }

  for (const [state, reason] of [
    [{ classified: false }, "[plan-gate] denied: classified session identity mismatch"],
    [{ session_id: "outra" }, "[plan-gate] denied: classified session identity mismatch"],
    [{ mode: "QUICK" }, "[plan-gate] denied: classified LIGHT/FULL feature required"],
    [{ feature_id: "" }, "[plan-gate] denied: classified LIGHT/FULL feature required"],
  ]) {
    const f = fixture(validPlan(), state);
    try {
      assert.equal(dispatch(f.root).decision.reason, reason);
    } finally { f.close(); }
  }
});

test("projectRoot inválido nega com a reason de identidade de caminho", () => {
  assert.equal(
    decidePiPlanGate({ projectRoot: "", sessionId: SESSION, toolName: "subagent", input: { subagent_type: "harness-executor", prompt: MARKER } }).reason,
    "[plan-gate] denied: invalid projectRoot",
  );
});

test("papéis não guardados e tools que não disparam subagente passam sem tocar disco", () => {
  const bogus = "/pi-plan-gate/does/not/exist";
  for (const role of ["harness-adversary", "harness-planner", "harness-compliance", "harness-shipper"]) {
    assert.deepEqual(dispatch(bogus, { role, prompt: "attack this" }).decision, { block: false });
  }
  assert.deepEqual(
    decidePiPlanGate({ projectRoot: bogus, sessionId: SESSION, toolName: "bash", input: { command: "ls" } }),
    { block: false },
  );
  assert.deepEqual(
    decidePiPlanGate({ projectRoot: bogus, sessionId: SESSION, toolName: "get_subagent_result", input: { subagent_type: "harness-executor" } }),
    { block: false },
  );
  // Sem plano/gate-state nesse root, o mesmo dispatch guardado seria negado.
  assert.equal(dispatch(bogus).decision.block, true);
});

test("validador quebrado abre com warn (fail-open do decidePlanGate), sem bloquear", () => {
  const f = fixture();
  try {
    const decision = decidePiPlanGate(
      { projectRoot: f.root, sessionId: SESSION, toolName: "subagent", input: { subagent_type: "harness-executor", prompt: MARKER, complexity: "medium" } },
      { validatePlanFn: () => { throw new Error("boom"); } },
    );
    assert.equal(decision.block, false);
    assert.match(decision.warn, /^\[plan-gate\] \[plan-gate\] Warning:/);
  } finally { f.close(); }
});

test("plano reprovado pelo validador injetado é negado com os erros do validador", () => {
  const f = fixture();
  try {
    const decision = decidePiPlanGate(
      { projectRoot: f.root, sessionId: SESSION, toolName: "subagent", input: { subagent_type: "harness-executor", prompt: MARKER } },
      { validatePlanFn: () => ({ ok: false, errors: ["tasks[0].id missing"] }) },
    );
    assert.equal(decision.block, true);
    assert.match(decision.reason, /^\[plan-gate\] Blocked: validatePlan\(expect=full\) failed: tasks\[0\]\.id missing$/);
  } finally { f.close(); }
});

test("helpers puros: isPlanGuardedRole e dispatchIds", () => {
  for (const role of ["plan-reviewer", "test-author", "executor", "executor-high", "sniper", "sniper-high"]) {
    assert.equal(isPlanGuardedRole(role), true, role);
  }
  for (const role of ["adversary", "planner", "compliance", "security", "shipper", "harvester", "", null]) {
    assert.equal(isPlanGuardedRole(role), false, String(role));
  }
  assert.deepEqual(dispatchIds(null), { featureId: "", taskId: "" });
  assert.deepEqual(dispatchIds({ input: { feature_id: " f1 ", task: "t1" } }), { featureId: "f1", taskId: "t1" });
  assert.deepEqual(dispatchIds({ featureId: "f2", taskId: "t2" }), { featureId: "f2", taskId: "t2" });
  // Primeiro NÃO-VAZIO vence (semântica de aliasValues do OC), não o primeiro presente.
  assert.deepEqual(
    dispatchIds({ feature_id: "", featureId: "  ", feature: "f3", taskId: "", task: "t3" }),
    { featureId: "f3", taskId: "t3" },
  );
});
