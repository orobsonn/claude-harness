/**
 * @description Testes da peça entry-gate da lane Pi. Cobrem as decisões de bloqueio/permissão,
 * o contrato fail-open/fail-closed e a IDENTIDADE das mensagens com a lane OC (espelhando os
 * casos de core/opencode/plugin/entry-gate.test.mjs). Nenhuma decisão é reimplementada no teste:
 * as mensagens esperadas são conferidas contra as MESMAS funções puras da lane OC
 * (corruptRegatePendingReason, decideBashHarnessLabel) quando o texto é longo.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { corruptRegatePendingReason } from "../../shared/lib/regate-classify.mjs";
import { decideBashHarnessLabel } from "../../opencode/plugin/lib/bash-decide.mjs";
import {
  decidePiBashGate,
  decidePiDispatchGate,
  excludePiHarnessArtifacts,
  extractPiFeatureTaskIds,
  isWritingHandRole,
  recordPiTaskCompletion,
} from "./entry-gate.mjs";
import { claimPiDispatchForRuntime, readPiDispatchRecord } from "./pi-state-records.mjs";

const ROOT = "/tmp/pi-entry-gate-fake-root";
const SESSION = "018f6b0c-8f2a-7c1d-9e3b-5a1c2d3e4f50";
const FEATURE = "pi-gates";

/** @description Cria um loader de gate-state falso com o Result exato da peça gate-state-io. */
const loaderOf = (result) => () => result;
/** @description Loader que devolve estado pronto (o caso feliz). */
const stateOf = (state) => loaderOf({ ok: true, state, path: "/dev/null" });

/** @description Dispatch com todas as costuras de IO injetadas (nada toca disco). */
function dispatch(overrides = {}) {
  return decidePiDispatchGate({
    projectRoot: ROOT,
    sessionId: SESSION,
    env: {},
    isAncestorFn: () => null,
    claimDispatchFn: () => ({ ok: true }),
    readCanonicalTaskPolicyFn: () => ({ ok: true, noTests: false, planHash: "" }),
    ...overrides,
  });
}

/** @description Bash com todas as costuras de IO injetadas (nada toca disco nem git). */
function bash(overrides = {}) {
  return decidePiBashGate({
    projectRoot: ROOT,
    sessionId: SESSION,
    env: {},
    isAncestorFn: () => null,
    listHandRecordsForFeatureFn: () => [],
    gitStateFn: () => null,
    readMergeCheckRollupFn: () => null,
    isLifecycleOnlyMergeFn: () => false,
    loadGateStateFn: stateOf({}),
    ...overrides,
  });
}

/* ------------------------------------------------------------------ *
 * Dispatch de subagente                                               *
 * ------------------------------------------------------------------ */

test("QUICK bloqueia o dispatch do executor com a mensagem de modo da lane OC", () => {
  const out = dispatch({
    subagentType: "harness-executor",
    toolArgs: { prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t1"}[/HARNESS_TASK_CONTEXT]' },
    loadGateStateFn: stateOf({ classified: true, mode: "QUICK", feature_id: FEATURE }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /^\[entry-gate\] Blocked: mode 'QUICK' forbids executor/);
  assert.match(out.reason, /choosing mode LIGHT or FULL/);
});

test("ceremony ausente (sem classified e sem mode) nega com a mensagem de ceremony", () => {
  const out = dispatch({ subagentType: "harness-planner", loadGateStateFn: stateOf({}) });
  assert.equal(out.decision, "deny");
  assert.equal(
    out.reason,
    "[entry-gate] Blocked: ceremony missing — run oc-triaging-requests and classify before dispatching delivery agents.",
  );
});

test("LIGHT permite o adversary de spec draft e FULL permite o executor com fidelity-pass", () => {
  const light = dispatch({
    subagentType: "harness-adversary",
    loadGateStateFn: stateOf({ classified: true, mode: "LIGHT", feature_id: FEATURE, spec_status: "draft", spec_sha256: "a".repeat(64) }),
    readSpecApprovalFn: () => ({ ok: false, reason: "current adversary-reviewed spec required" }),
    readSpecDraftFn: () => ({ ok: true, sha256: "a".repeat(64) }),
  });
  assert.equal(light.decision, "allow");

  const full = dispatch({
    subagentType: "harness-executor",
    toolCallId: "call-1",
    toolArgs: { prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t1"}[/HARNESS_TASK_CONTEXT]' },
    loadGateStateFn: stateOf({
      classified: true,
      mode: "FULL",
      feature_id: FEATURE,
      fidelity_pass: [`${FEATURE}/t1`],
    }),
  });
  assert.equal(full.decision, "allow");
});

test("adversary pós-implementação não exige uma spec que já foi selada", () => {
  const out = dispatch({
    subagentType: "harness-adversary",
    loadGateStateFn: stateOf({
      classified: true,
      mode: "FULL",
      feature_id: FEATURE,
      brainstormed: true,
      adversary_fired: true,
      spec_status: "adversary-reviewed",
    }),
    readSpecDraftFn: () => ({ ok: false, reason: "current canonical spec draft required" }),
  });
  assert.equal(out.decision, "allow");
});

test("planner Pi exige spec revisada pelo adversário e vinculada ao hash atual", () => {
  const state = { classified: true, mode: "FULL", feature_id: FEATURE, brainstormed: true, adversary_fired: true };
  const absent = dispatch({ subagentType: "harness-planner", loadGateStateFn: stateOf(state), readSpecApprovalFn: () => ({ ok: false, reason: "current adversary-reviewed spec required" }) });
  assert.equal(absent.decision, "deny");
  assert.match(absent.reason, /current adversary-reviewed spec required/);

  const allowed = dispatch({
    subagentType: "harness-planner",
    loadGateStateFn: stateOf(state),
    readSpecApprovalFn: () => ({ ok: true, sha256: "a".repeat(64) }),
  });
  assert.equal(allowed.decision, "allow");
});

test("planner sem brainstormed devolve o JSON CEREMONY_PROOF_REQUIRED literal", () => {
  const out = dispatch({
    subagentType: "harness-planner",
    loadGateStateFn: stateOf({ classified: true, mode: "FULL", feature_id: FEATURE }),
  });
  assert.equal(out.decision, "deny");
  assert.equal(
    out.reason,
    `[entry-gate] ${JSON.stringify({
      code: "CEREMONY_PROOF_REQUIRED",
      missing_proof: "brainstorming_completion_evidence",
      next_transition: { phase: "brainstorming", action: "resume", marker: "brainstormed" },
    })}`,
  );
});

test("planner com brainstormed mas sem adversary_fired pede a prova do spec-adversary", () => {
  const out = dispatch({
    subagentType: "harness-planner",
    loadGateStateFn: stateOf({ classified: true, mode: "FULL", feature_id: FEATURE, brainstormed: true }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /spec_adversary_completion_evidence/);
});

test("executor e sniper exigem fidelity-pass da tarefa exata", () => {
  const out = dispatch({
    subagentType: "harness-executor",
    toolCallId: "call-1",
    toolArgs: { prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t1"}[/HARNESS_TASK_CONTEXT]' },
    loadGateStateFn: stateOf({ classified: true, mode: "FULL", feature_id: FEATURE }),
  });
  assert.equal(out.decision, "deny");
  assert.equal(
    out.reason,
    `[entry-gate] Blocked: executor requires fidelity-pass for feature '${FEATURE}' before spawn; dispatch test-author first.`,
  );

  for (const subagentType of ["harness-executor", "harness-sniper"]) {
    const wrongTask = dispatch({
      subagentType,
      toolCallId: "call-exact",
      toolArgs: { prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t2"}[/HARNESS_TASK_CONTEXT]' },
      loadGateStateFn: stateOf({
        classified: true,
        mode: "FULL",
        feature_id: FEATURE,
        fidelity_pass: [`${FEATURE}/t1`],
      }),
    });
    assert.equal(wrongTask.decision, "deny", subagentType);
    assert.equal(
      wrongTask.reason,
      `[entry-gate] Blocked: ${subagentType.replace("harness-", "")} requires task-scoped fidelity-pass for ${FEATURE}/t2 before spawn.`,
    );
  }
});

test("re-gate pendente de outra tarefa bloqueia nova mão escritora", () => {
  const out = dispatch({
    subagentType: "harness-executor",
    toolCallId: "call-other-task",
    toolArgs: { prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t2"}[/HARNESS_TASK_CONTEXT]' },
    isAncestorFn: () => false,
    loadGateStateFn: stateOf({
      classified: true, mode: "FULL", feature_id: FEATURE,
      fidelity_pass: [`${FEATURE}/t2`], regate_pending: [`${FEATURE}/t1`], regate_passed: [],
    }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /another task requires adversary re-gate/);
});

test("shipper com regate_pending sem regate_passed é negado", () => {
  const out = dispatch({
    subagentType: "harness-shipper",
    loadGateStateFn: stateOf({
      classified: true,
      mode: "FULL",
      feature_id: FEATURE,
      regate_pending: [`${FEATURE}/t9`],
    }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /still await the mandatory strong-eye re-gate/);
  assert.match(out.reason, new RegExp(`${FEATURE}/t9`));
});

test("gate-state ilegível NÃO nega por si só no dispatch (fail-open) e loga", () => {
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(String(msg));
  let out;
  try {
    out = dispatch({
      subagentType: "harness-adversary",
      loadGateStateFn: loaderOf({ ok: false, reason: "gate-state invalid JSON object at /x" }),
    });
  } finally {
    console.error = original;
  }
  // O loader não nega; o que decide é decideEntryTask contra o estado vazio — exatamente como
  // na lane OC (a ceremony continua ausente, e é ESSA a mensagem, não a do gate-state).
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /^\[entry-gate\] Blocked: ceremony missing/);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[entry-gate\] gate-state unreadable, allowing dispatch: gate-state invalid JSON/);
});

test("gate-state ilegível com ceremony ausente ainda permite papel não-delivery", () => {
  const out = dispatch({
    subagentType: "general-purpose",
    loadGateStateFn: loaderOf({ ok: false, reason: "gate-state invalid JSON object at /x" }),
  });
  assert.equal(out.decision, "allow");
});

test("falha de IDENTIDADE de sessão é fail-closed no dispatch de delivery", () => {
  const out = dispatch({
    subagentType: "harness-adversary",
    loadGateStateFn: loaderOf({ ok: false, reason: "unsafe sessionId" }),
  });
  assert.equal(out.decision, "deny");
  assert.equal(out.reason, "[entry-gate] unsafe sessionId");
});

test("papel não-delivery passa mesmo com falha de identidade de sessão", () => {
  const out = dispatch({
    subagentType: "general-purpose",
    loadGateStateFn: loaderOf({ ok: false, reason: "unsafe sessionId" }),
  });
  assert.equal(out.decision, "allow");
});

test("toda mão escritora sem identidade exata é negada, inclusive fora de fix mode", () => {
  const out = dispatch({
    subagentType: "harness-executor",
    toolArgs: {},
    env: {},
    loadGateStateFn: stateOf({
      classified: true,
      mode: "FULL",
      feature_id: FEATURE,
      fidelity_pass: [`${FEATURE}/t1`],
    }),
  });
  assert.equal(out.decision, "deny");
  assert.equal(out.reason, "[entry-gate] exact dispatch identity required for writing hand");
});

test("dispatch-record recusado nega com a reason da peça state-records", () => {
  const out = dispatch({
    subagentType: "harness-executor",
    toolCallId: "call-9",
    toolArgs: { prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t1"}[/HARNESS_TASK_CONTEXT]' },
    claimDispatchFn: () => ({ ok: false, reason: "stable plan missing" }),
    loadGateStateFn: stateOf({
      classified: true,
      mode: "FULL",
      feature_id: FEATURE,
      fidelity_pass: [`${FEATURE}/t1`],
    }),
  });
  assert.equal(out.decision, "deny");
  assert.equal(out.reason, "[entry-gate] exact dispatch record rejected: stable plan missing");
});

test("taskId dos args divergindo do marcador do brief é fail-closed", () => {
  const out = dispatch({
    subagentType: "harness-executor",
    toolCallId: "call-1",
    toolArgs: {
      prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"t1"}[/HARNESS_TASK_CONTEXT]',
      taskId: "t2",
    },
    loadGateStateFn: stateOf({ classified: true, mode: "FULL", feature_id: FEATURE }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /^\[entry-gate\] taskId dispatch args diverge from the brief/);
});

test("extractPiFeatureTaskIds lê os ids opcionais dos args, inclusive aninhados", () => {
  assert.deepEqual(extractPiFeatureTaskIds({ feature_id: "f", taskId: "t" }), {
    featureId: "f",
    taskId: "t",
  });
  assert.deepEqual(extractPiFeatureTaskIds({ input: { featureId: "f2", task: "t2" } }), {
    featureId: "f2",
    taskId: "t2",
  });
  assert.deepEqual(extractPiFeatureTaskIds(null), {});
});

test("isWritingHandRole reconhece o vocabulário do Pi e o bare da lane OC", () => {
  for (const role of ["harness-executor", "harness-sniper", "harness-test-author", "executor"]) {
    assert.equal(isWritingHandRole(role), true, role);
  }
  for (const role of ["harness-adversary", "planner", "", null]) {
    assert.equal(isWritingHandRole(role), false, String(role));
  }
});

/* ------------------------------------------------------------------ *
 * Bash                                                                *
 * ------------------------------------------------------------------ */

test("git push em branch protegida é negado", async () => {
  const out = await bash({
    command: "git push origin main",
    gitStateFn: () => ({ branch: "main", commitsAhead: 3, defaultBranch: "main" }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /^\[entry-gate\] Blocked: delivery command on protected branch 'main'\./);
});

test("delivery com zero commits à frente da base é negado", async () => {
  const out = await bash({
    command: "gh pr create --title x --body y",
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 0, defaultBranch: "main" }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /zero commits ahead of base/);
});

test("regate_pending corrompido (não-array) NEGA — única exceção fail-closed", async () => {
  const out = await bash({
    command: "git push origin feat/x",
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2, defaultBranch: "main" }),
    loadGateStateFn: stateOf({ regate_pending: "harness/t1" }),
  });
  assert.equal(out.decision, "deny");
  assert.equal(out.reason, corruptRegatePendingReason("harness/t1"));
});

test("hand_finished não-array coage para [] e permite a delivery", async () => {
  const out = await bash({
    command: "git push origin feat/x",
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2, defaultBranch: "main" }),
    loadGateStateFn: stateOf({ hand_finished: "oops", capture_verified: 7, regate_passed: 3 }),
  });
  assert.equal(out.decision, "allow");
});

test("hand_finished sem capture_verified nega a delivery", async () => {
  const out = await bash({
    command: "git push origin feat/x",
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2, defaultBranch: "main" }),
    loadGateStateFn: stateOf({ hand_finished: [`${FEATURE}/t1`] }),
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /still await independent capture\/verification/);
});

test("gate-state ilegível permite bash (fail-open total)", async () => {
  const out = await bash({
    command: "git push origin feat/x",
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2, defaultBranch: "main" }),
    loadGateStateFn: loaderOf({ ok: false, reason: "gate-state invalid JSON object at /x" }),
  });
  assert.equal(out.decision, "allow");
});

test("gate-state que lança na leitura ainda permite bash", async () => {
  const out = await bash({
    command: "ls -la",
    loadGateStateFn: () => {
      throw new Error("boom");
    },
  });
  assert.equal(out.decision, "allow");
});

test("gh pr merge sem evidência de CI é fail-CLOSED", async () => {
  const out = await bash({
    command: "gh pr merge 42 --squash",
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2, defaultBranch: "main" }),
    readMergeCheckRollupFn: () => null,
  });
  assert.equal(out.decision, "deny");
  assert.equal(out.reason, "[entry-gate] Blocked: CI could not be read; merge is denied.");
});

test("gh pr merge com rollup verde passa", async () => {
  const out = await bash({
    command: "gh pr merge 42 --squash",
    gitStateFn: () => ({ branch: "feat/x", commitsAhead: 2, defaultBranch: "main" }),
    readMergeCheckRollupFn: () => [{ conclusion: "SUCCESS" }],
  });
  assert.equal(out.decision, "allow");
});

test("merge lifecycle-only sem CI preserva a exceção", async () => {
  const out = await bash({
    command: "gh pr merge --squash",
    gitStateFn: () => ({ branch: "chore/harness-lifecycle-updating-harness-1", commitsAhead: 1, defaultBranch: "main" }),
    readMergeCheckRollupFn: () => [],
    isLifecycleOnlyMergeFn: () => true,
  });
  assert.equal(out.decision, "allow");
});

test("label harness:ready em sessão filha é negado com o texto #808 completo", async () => {
  const command = 'gh issue create --title "[harness] x" --body-file /tmp/b.md --label harness:ready';
  const out = await bash({ command, isSubagent: true });
  const expected = decideBashHarnessLabel({ command, isRoutine: false, isSubagent: true });
  assert.equal(out.decision, "deny");
  assert.equal(out.reason, expected.reason);
  assert.match(out.reason, /^\[entry-gate\] Blocked: attaching `harness:ready`/);
  assert.match(out.reason, /RECORD THE FINDING ANYWAY/);
});

test("label harness:ready na sessão principal interativa continua permitido", async () => {
  const out = await bash({
    command: 'gh issue create --title "[harness] x" --body-file /tmp/b.md --label harness:ready',
    isSubagent: false,
  });
  assert.equal(out.decision, "allow");
});

test("label harness:* numa sessão ROTINA (env) é negado mesmo sem sessão filha", async () => {
  const out = await bash({
    command: "gh issue edit 12 --add-label harness:queued",
    isSubagent: false,
    env: { HARNESS_NOTIFY_PROJECT: "" , CLAUDE_CODE_REMOTE: "1" },
  });
  assert.equal(out.decision, "deny");
  assert.match(out.reason, /attaching `harness:queued`/);
});

test("gh issue create sem label em sessão filha recebe o ROUTINE_ISSUE_ADVISORY", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-entry-gate-"));
  try {
    mkdirSync(join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(join(dir, ".github", "ISSUE_TEMPLATE", "harness-task.yml"), "name: harness\n");
    const sink = {};
    const out = await bash({
      command: 'gh issue create --title "[harness] x" --body-file /tmp/b.md',
      projectRoot: dir,
      isSubagent: true,
      advisorySink: sink,
    });
    assert.equal(out.decision, "allow");
    assert.match(out.advisory, /You are in a harness ROUTINE session/);
    assert.match(out.advisory, /create it label-free/);
    assert.equal(sink.metadata.bash_advisory, out.advisory);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("gh issue create numa sessão interativa recebe o advisory do formulário, não o de rotina", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-entry-gate-"));
  try {
    mkdirSync(join(dir, ".github", "ISSUE_TEMPLATE"), { recursive: true });
    writeFileSync(join(dir, ".github", "ISSUE_TEMPLATE", "harness-task.yml"), "name: harness\n");
    const out = await bash({
      command: 'gh issue create --title "[harness] x" --body-file /tmp/b.md',
      projectRoot: dir,
      isSubagent: false,
    });
    assert.equal(out.decision, "allow");
    assert.doesNotMatch(out.advisory ?? "", /You are in a harness ROUTINE session/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("denylist de frota nega comando perigoso só sob HARNESS_NOTIFY_PROJECT", async () => {
  const denied = await bash({ command: "bash -c 'rm -rf /'", env: { HARNESS_NOTIFY_PROJECT: "x" } });
  assert.equal(denied.decision, "deny");
  assert.match(denied.reason, /fleet bash denylist choke-point/);
  assert.match(denied.reason, /issue #516/);

  const interactive = await bash({ command: "bash -c 'rm -rf /'", env: {} });
  assert.equal(interactive.decision, "allow");
});

test("denylist ausente é fail-open RUIDOSO (nunca silencioso)", async () => {
  const errors = [];
  const original = console.error;
  console.error = (msg) => errors.push(String(msg));
  let out;
  try {
    out = await bash({
      command: "bash -c 'rm -rf /'",
      env: { HARNESS_NOTIFY_PROJECT: "x" },
      importDenylistFn: () => Promise.reject(new Error("module missing")),
    });
  } finally {
    console.error = original;
  }
  assert.equal(out.decision, "allow");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\[entry-gate\] denylist choke-point unavailable, allowing dispatch: module missing/);
});

test("comando comum não-delivery passa sem tocar git", async () => {
  let probed = false;
  const out = await bash({
    command: "npm test",
    gitStateFn: () => {
      probed = true;
      return null;
    },
  });
  assert.equal(out.decision, "allow");
  assert.equal(probed, false);
});

/* ------------------------------------------------------------------ *
 * Conclusão de mão (recordPiTaskCompletion) — caminhos .pi/harness/    *
 * ------------------------------------------------------------------ */

const MODEL_STRATEGY = {
  hand_tiers: { low: "openai/luna", medium: "openai/luna", high: "openai/terra" },
  planner: "openai/planner",
  "plan-reviewer": "openai/reviewer",
  compliance: "openai/compliance",
  adversary: "openai/adversary",
  security: "openai/security",
  shipper: "openai/shipper",
  harvester: "openai/harvester",
};

/** @description Projeto Pi real com plano estável + gate-state FULL, para o caminho de conclusão. */
function completionFixture({ noTests = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-entry-gate-completion-"));
  const sessionId = "ses-pi-completion";
  const featureId = "feat-pi-completion";
  const plan = {
    feature_id: featureId,
    mode: "full",
    model_strategy: MODEL_STRATEGY,
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks: [
      {
        id: "task-1",
        scope_paths: ["src/a.ts"],
        criterion_refs: ["#ac-1"],
        locked_tests: noTests
          ? []
          : [{ id: "lt-1", path: "tests/a.test.mjs", assertion: "Given task, When complete, Then observable a" }],
        ...(noTests ? { no_tests: true } : {}),
        title: "Implement task-1",
        description: "Implement task-1.",
        depends_on: [],
        severity: "medium",
        complexity: "medium",
        resolved_judgments: { scope: "fixed" },
        adversarial: { enabled: false, focus: [] },
      },
    ],
  };
  mkdirSync(join(root, ".pi", "harness", "plans", featureId), { recursive: true });
  writeFileSync(
    join(root, ".pi", "harness", "plans", featureId, "execution-plan.json"),
    JSON.stringify(plan),
  );
  mkdirSync(join(root, ".pi", "harness", "state", sessionId), { recursive: true });
  writeFileSync(
    join(root, ".pi", "harness", "state", sessionId, "gate-state.json"),
    JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true, mode: "FULL" }),
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "a.ts"), "export const value = 1;\n");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "pi-entry-gate@example.test"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Pi entry gate test"], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return { root, sessionId, featureId, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("artefatos internos do runtime Pi não são atribuídos à mão como mudança de produto", () => {
  const touched = excludePiHarnessArtifacts([
    ".pi/harness/runtime/sessions/run.jsonl",
    ".pi/harness/state/ses-pi-completion/dispatch-records/call.json",
    ".pi/harness/plans/feat-pi-completion/execution-plan.json",
    "src/a.ts",
  ]);

  assert.deepEqual(touched, [
    ".pi/harness/plans/feat-pi-completion/execution-plan.json",
    "src/a.ts",
  ]);
});

test("plano canônico no_tests despacha executor e ainda exige hand/captura", async () => {
  const f = completionFixture({ noTests: true });
  try {
    const dispatched = decidePiDispatchGate({
      projectRoot: f.root,
      sessionId: f.sessionId,
      subagentType: "harness-executor",
      toolCallId: "call-no-tests",
      toolArgs: { prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]' },
      env: {},
      isAncestorFn: () => null,
    });
    assert.equal(dispatched.decision, "allow", dispatched.reason);

    const dispatchRecord = readPiDispatchRecord(f.root, {
      parentSessionId: f.sessionId,
      callId: "call-no-tests",
    });
    assert.equal(dispatchRecord.ok, true, dispatchRecord.reason);
    assert.equal(dispatchRecord.record.role, "harness-executor");
    assert.deepEqual(dispatchRecord.record.frozen_paths, []);

    writeFileSync(join(f.root, "src", "a.ts"), "export const value = 2;\n");
    const completed = recordPiTaskCompletion({
      projectRoot: f.root,
      sessionId: f.sessionId,
      featureId: f.featureId,
      taskId: "task-1",
      role: "harness-executor",
      producerCallId: "call-no-tests",
      outputText: "Status: DONE",
    });
    assert.equal(completed.ok, true, completed.reason);
    assert.equal(completed.capturePending, true);

    const beforeCapture = await decidePiBashGate({
      projectRoot: f.root,
      sessionId: f.sessionId,
      command: "git push origin feat/no-tests",
      env: {},
      gitStateFn: () => ({ branch: "feat/no-tests", commitsAhead: 1, defaultBranch: "main" }),
    });
    assert.equal(beforeCapture.decision, "deny");
    assert.match(beforeCapture.reason, /still await independent capture\/verification/);
  } finally {
    f.close();
  }
});

test("no_tests declarado no prompt não libera tarefa canônica com teste travado", () => {
  const f = completionFixture();
  try {
    const out = decidePiDispatchGate({
      projectRoot: f.root,
      sessionId: f.sessionId,
      subagentType: "harness-executor",
      toolCallId: "call-forged-no-tests",
      toolArgs: {
        no_tests: true,
        prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]',
      },
      env: {},
      isAncestorFn: () => null,
    });
    assert.equal(out.decision, "deny");
    assert.match(out.reason, /requires fidelity-pass/);
  } finally {
    f.close();
  }
});

test("capture real ignora só runtime/state do host e mantém o arquivo de produto atribuído", () => {
  const f = completionFixture();
  try {
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: f.sessionId, callId: "call-capture", role: "harness-executor", taskId: "task-1", featureId: f.featureId },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);
    writeFileSync(join(f.root, "src", "a.ts"), "export const value = 2;\n");
    mkdirSync(join(f.root, ".pi", "harness", "runtime"), { recursive: true });
    writeFileSync(join(f.root, ".pi", "harness", "runtime", "session.jsonl"), "host artifact\n", { flag: "w" });
    writeFileSync(join(f.root, ".pi", "harness", "state", "runtime-lock.json"), "host artifact\n", { flag: "w" });

    const out = recordPiTaskCompletion({
      projectRoot: f.root,
      sessionId: f.sessionId,
      featureId: f.featureId,
      taskId: "task-1",
      role: "harness-executor",
      producerCallId: "call-capture",
      outputText: "Status: DONE",
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.capturePending, true);
    const record = JSON.parse(readFileSync(
      join(f.root, ".pi", "harness", "state", "hand-records", f.featureId, f.sessionId, "task-1.json"),
      "utf8",
    ));
    assert.deepEqual(record.touchedPaths, ["src/a.ts"]);
  } finally {
    f.close();
  }
});

test("capture real não ignora subdiretórios com prefixo parecido", () => {
  const f = completionFixture();
  try {
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: f.sessionId, callId: "call-prefix", role: "harness-executor", taskId: "task-1", featureId: f.featureId },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);
    mkdirSync(join(f.root, ".pi", "harness", "runtime-evil"), { recursive: true });
    mkdirSync(join(f.root, ".pi", "harness", "state-evil"), { recursive: true });
    writeFileSync(join(f.root, ".pi", "harness", "runtime-evil", "outside.ts"), "outside\n");
    writeFileSync(join(f.root, ".pi", "harness", "state-evil", "outside.ts"), "outside\n");

    const out = recordPiTaskCompletion({
      projectRoot: f.root,
      sessionId: f.sessionId,
      featureId: f.featureId,
      taskId: "task-1",
      role: "harness-executor",
      producerCallId: "call-prefix",
      outputText: "Status: DONE",
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.capturePending, false);
    const record = JSON.parse(readFileSync(
      join(f.root, ".pi", "harness", "state", "hand-records", f.featureId, f.sessionId, "task-1.json"),
      "utf8",
    ));
    assert.equal(record.outcome, "BLOCKED");
    assert.deepEqual(record.scopeViolations, [
      ".pi/harness/runtime-evil/outside.ts",
      ".pi/harness/state-evil/outside.ts",
    ]);
  } finally {
    f.close();
  }
});

test("conclusão DONE grava o hand-record sob .pi/harness/state e carimba hand_finished", () => {
  const f = completionFixture();
  try {
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: f.sessionId, callId: "call-1", role: "harness-executor", taskId: "task-1", featureId: f.featureId },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);

    const out = recordPiTaskCompletion({
      projectRoot: f.root,
      sessionId: f.sessionId,
      featureId: f.featureId,
      taskId: "task-1",
      role: "harness-executor",
      producerCallId: "call-1",
      outputText: "Status: DONE",
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.terminal, true);
    assert.equal(out.recorded, true);
    assert.equal(out.capturePending, true);

    const recordPath = join(
      f.root, ".pi", "harness", "state", "hand-records", f.featureId, f.sessionId, "task-1.json",
    );
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    assert.equal(record.outcome, "DONE");
    assert.equal(record.producerCallId, "call-1");
    assert.equal(record.writtenBy, "host-hand-finished");

    const gateState = JSON.parse(
      readFileSync(join(f.root, ".pi", "harness", "state", f.sessionId, "gate-state.json"), "utf8"),
    );
    assert.deepEqual(gateState.hand_finished, [`${f.featureId}/task-1`]);
  } finally {
    f.close();
  }
});

test("conclusão sem dispatch-record do produtor exato é fail-closed e não carimba nada", () => {
  const f = completionFixture();
  try {
    const out = recordPiTaskCompletion({
      projectRoot: f.root,
      sessionId: f.sessionId,
      featureId: f.featureId,
      taskId: "task-1",
      role: "harness-executor",
      producerCallId: "call-inexistente",
      outputText: "Status: DONE",
    });
    assert.equal(out.ok, false);
    assert.equal(out.terminal, true);
    assert.equal(out.reason, "exact producer dispatch record required");
    const gateState = JSON.parse(
      readFileSync(join(f.root, ".pi", "harness", "state", f.sessionId, "gate-state.json"), "utf8"),
    );
    assert.equal(gateState.hand_finished, undefined);
  } finally {
    f.close();
  }
});

test("mão que não declara status termina BLOCKED e não fica pendente de captura", () => {
  const f = completionFixture();
  try {
    const claimed = claimPiDispatchForRuntime(
      f.root,
      { sessionId: f.sessionId, callId: "call-2", role: "harness-executor", taskId: "task-1", featureId: f.featureId },
      { env: {}, isAncestorFn: () => null },
    );
    assert.equal(claimed.ok, true, claimed.reason);

    const out = recordPiTaskCompletion({
      projectRoot: f.root,
      sessionId: f.sessionId,
      featureId: f.featureId,
      taskId: "task-1",
      role: "harness-executor",
      producerCallId: "call-2",
      outputText: "sem linha de status nenhuma",
    });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.capturePending, false);

    const record = JSON.parse(
      readFileSync(
        join(f.root, ".pi", "harness", "state", "hand-records", f.featureId, f.sessionId, "task-1.json"),
        "utf8",
      ),
    );
    assert.equal(record.outcome, "BLOCKED");
    const gateState = JSON.parse(
      readFileSync(join(f.root, ".pi", "harness", "state", f.sessionId, "gate-state.json"), "utf8"),
    );
    assert.deepEqual(gateState.hand_finished ?? [], []);
  } finally {
    f.close();
  }
});
