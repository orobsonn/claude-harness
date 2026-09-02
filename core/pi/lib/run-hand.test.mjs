/**
 * @description Testes travados da mão barata da lane Pi. Espelham os casos de
 * core/opencode/hands/run-hand.test.mjs (t7-*), provando que só mudam o host (launcher/agente/
 * modelo) e o prefixo de estado (`.pi/harness/state/`): oráculo, política de worktree, quarentena,
 * formato do record e mensagens de negação continuam idênticos à lane OC.
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  OUTCOME,
  PI_HAND_EXCLUDED_TOOLS,
  PI_HAND_MODEL_PREFIX,
  RUN_HAND_TOOL_NAME,
  SPAWNABLE_HAND_ROLES,
  VACUOUS_GREEN_EXIT,
  buildPiRunArgs,
  createPiRunHandTool,
  decidePiRunHandSpawn,
  defaultHasPiFidelityPass,
  defaultIsPiHandQuarantined,
  loadAndValidatePiHandAgent,
  piHandAgentName,
  resolvePiHandModel,
  runPiHand,
  validatePiHandAgent,
} from "./run-hand.mjs";
import { mergeGateState } from "./pi-gate-state.mjs";
import { piGateStatePath } from "./pi-paths.mjs";

const MODEL_STRATEGY = { hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" }, planner: "openai/planner", "plan-reviewer": "openai/reviewer", compliance: "openai/compliance", adversary: "openai/adversary", security: "openai/security", shipper: "openai/shipper", harvester: "openai/harvester" };

const HAND_MODEL = "openai-codex/gpt-5.6-terra";

/** Frontmatter vendorizado real de uma mão do Pi (core/pi/runtime/agents/harness-executor.md). */
const PI_HAND_FM = `---
description: Focused implementation hand for an approved, bounded task.
tools: read, grep, find, ls, bash, edit, write
locked: true
---
# body
`;

const PI_UNLOCKED_FM = `---
description: unlocked hand
tools: read, edit, write
locked: false
---
# body
`;

const PI_DISPATCHER_FM = `---
description: dispatching hand
tools: read, edit, write, subagent
locked: true
---
# body
`;

/** @description Cria um projeto temporário; remove tudo no close. */
function tempProject(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { root, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * @description Projeto Pi com plano estável válido, gate-state classificado FULL e o diretório de
 * agentes materializado — o mínimo para claimPiDispatchForRuntime resolver o escopo canônico.
 * @param {{ prefix?: string, scopePaths?: string[], roles?: string[] }} [opts]
 */
function piHandFixture({ prefix = "pi-run-hand-", scopePaths = ["src"], roles = ["harness-executor", "harness-test-author"] } = {}) {
  const { root, close } = tempProject(prefix);
  const sessionId = "ses-pi-hand";
  const featureId = "feat-pi-hand";
  const taskId = "task-1";
  const plan = {
    feature_id: featureId,
    mode: "full",
    model_strategy: MODEL_STRATEGY,
    final_review: { compliance: true, adversary: true },
    demo: { type: "smoke", scenarios_from_refs: ["#uj-1"] },
    tasks: [{
      id: taskId,
      title: "Implement the hand task",
      description: "Implement the scoped hand task.",
      depends_on: [],
      severity: "medium",
      complexity: "medium",
      scope_paths: scopePaths,
      resolved_judgments: { scope: "fixed" },
      criterion_refs: ["#ac-1"],
      locked_tests: [{ id: "lt-1", path: "tests/foo.test.mjs", assertion: "Given foo, When run, Then ok" }],
      adversarial: { enabled: false, focus: [] },
    }],
  };
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "foo.test.mjs"), "// locked\n");
  const planDir = path.join(root, ".pi", "harness", "plans", featureId);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "execution-plan.json"), JSON.stringify(plan));
  const stateDir = path.join(root, ".pi", "harness", "state", sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: sessionId,
    feature_id: featureId,
    mode: "FULL",
    classified: true,
    delivery_status: "ready",
  }));
  const agentsDir = path.join(root, ".pi", "harness", "runtime", "agents");
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const role of roles) fs.writeFileSync(path.join(agentsDir, `${role}.md`), PI_HAND_FM);
  return { root, sessionId, featureId, taskId, stateDir, agentsDir, close };
}

/** @description Caminho do dispatch-record do Pi para um callId. */
function dispatchRecordPath(stateDir, callId) {
  return path.join(stateDir, "dispatch-records", `${crypto.createHash("sha256").update(callId).digest("hex")}.json`);
}

// ---- papéis, agentes e rota de modelo ----

test("piHandAgentName: o papel completo vira o asset sem tier do Pi", () => {
  assert.equal(piHandAgentName("harness-executor-high"), "harness-executor");
  assert.equal(piHandAgentName("harness-executor-low"), "harness-executor");
  assert.equal(piHandAgentName("harness-sniper-medium"), "harness-sniper");
  assert.equal(piHandAgentName("harness-test-author"), "harness-test-author");
  // Papel bare da lane OC também resolve (toOcRole é idempotente sobre o prefixo).
  assert.equal(piHandAgentName("executor-high"), "harness-executor");
  assert.equal(piHandAgentName(""), "");
});

test("SPAWNABLE_HAND_ROLES é literalmente o conjunto da lane OC", () => {
  assert.deepEqual([...SPAWNABLE_HAND_ROLES], [
    "executor-low",
    "executor-medium",
    "executor-high",
    "sniper-low",
    "sniper-medium",
    "sniper-high",
    "test-author",
  ]);
  assert.equal(VACUOUS_GREEN_EXIT, 1);
  assert.equal(RUN_HAND_TOOL_NAME, "run_hand");
});

test("validatePiHandAgent: exige lockdown do frontmatter vendorizado e recusa tool de despacho", () => {
  const ok = validatePiHandAgent(PI_HAND_FM, "harness-executor");
  assert.equal(ok.ok, true);

  const noFm = validatePiHandAgent("# sem frontmatter", "harness-executor");
  assert.equal(noFm.ok, false);
  assert.equal(noFm.outcome, OUTCOME.CONFIG_ERROR);
  assert.match(noFm.reason, /missing frontmatter/);

  const unlocked = validatePiHandAgent(PI_UNLOCKED_FM, "harness-executor");
  assert.equal(unlocked.ok, false);
  assert.match(unlocked.reason, /locked must be true/);

  const dispatcher = validatePiHandAgent(PI_DISPATCHER_FM, "harness-executor");
  assert.equal(dispatcher.ok, false);
  assert.match(dispatcher.reason, /must not include subagent/);
});

test("loadAndValidatePiHandAgent: arquivo ausente é CONFIG_ERROR", () => {
  const { root, close } = tempProject("pi-run-hand-agent-");
  try {
    const missing = loadAndValidatePiHandAgent(root, "harness-executor");
    assert.equal(missing.ok, false);
    assert.equal(missing.outcome, OUTCOME.CONFIG_ERROR);
    assert.match(missing.reason, /agent file missing/);

    fs.writeFileSync(path.join(root, "harness-executor.md"), PI_HAND_FM);
    assert.equal(loadAndValidatePiHandAgent(root, "harness-executor").ok, true);
  } finally {
    close();
  }
});

test("resolvePiHandModel: só openai-codex/* passa; nenhum default Anthropic é aceito", () => {
  assert.deepEqual(resolvePiHandModel(HAND_MODEL), { ok: true, model: HAND_MODEL });
  assert.equal(PI_HAND_MODEL_PREFIX, "openai-codex/");

  for (const bad of ["", "   ", null, undefined, "sonnet", "anthropic/claude-opus", "openai-codex/"]) {
    const r = resolvePiHandModel(bad);
    assert.equal(r.ok, false, String(bad));
  }
  assert.match(resolvePiHandModel("anthropic/claude-opus").reason, /openai-codex\/\* routes are approved/);
});

test("buildPiRunArgs: launcher headless do Pi, sem token no argv", () => {
  const args = buildPiRunArgs({ launcher: "/pkg/bin/pi-harness.mjs", model: HAND_MODEL, prompt: "implement" });
  assert.deepEqual(args, [
    "/pkg/bin/pi-harness.mjs",
    "-p",
    "--mode",
    "json",
    "--model",
    HAND_MODEL,
    "--exclude-tools",
    "subagent,get_subagent_result,steer_subagent",
    "--",
    "implement",
  ]);
  assert.ok(!args.some((a) => /token|secret|auth/i.test(a)));
});

test("buildPiRunArgs: o brief vai depois de '--', então um bullet inicial chega inteiro à mão", () => {
  // `-p` do Pi só adota o próximo argumento como prompt se ele não começar com '-' nem '@'
  // (dist/cli/args.js). Sem o '--', um brief em bullet viraria flag desconhecida e a mão rodaria
  // sem tarefa — diff vazio, NOT_DONE, e nenhum sinal de que o brief se perdeu.
  for (const brief of ["- Implemente o passo 1", "@relatorio.md é a referência", "--force nada"]) {
    const args = buildPiRunArgs({ launcher: "/pkg/bin/pi-harness.mjs", model: HAND_MODEL, prompt: brief });
    assert.equal(args.at(-1), brief);
    assert.equal(args.at(-2), "--");
  }
});

test("buildPiRunArgs: a tool de despacho do Pi é desligada no filho (paridade com tools.task:false)", () => {
  // O Pi não tem `--agent`: o frontmatter validado nunca vira persona do filho, e o launcher
  // carrega pi-subagents. `--exclude-tools` é o que impede a mão barata de despachar outra mão.
  const args = buildPiRunArgs({ launcher: "/pkg/bin/pi-harness.mjs", model: HAND_MODEL, prompt: "implement" });
  const excluded = args[args.indexOf("--exclude-tools") + 1].split(",");
  assert.deepEqual(excluded, [...PI_HAND_EXCLUDED_TOOLS]);
  assert.ok(excluded.includes("subagent"));
});

// ---- rail de spawn (paridade de mensagem com decideSpawnHandFidelity) ----

const UNREADABLE_DENY = (p) =>
  "[entry-gate] Blocked: spawn-hand.mjs dispatch denied — --descriptor flag was present " +
  `but the descriptor at '${p}' could not be resolved to a qualified ` +
  "feature_id/task_id (missing file, invalid JSON, or non-string ids). " +
  "The fidelity check requires a readable descriptor with string feature_id and task_id. " +
  "Ensure the descriptor JSON exists and is well-formed before dispatching.";

const FIDELITY_DENY = (feature, task) =>
  `[entry-gate] Blocked: spawn-hand.mjs dispatch denied — fidelity-pass for task ` +
  `${feature}/${task} has not been stamped. Dispatch the test-author first to produce ` +
  "a failing locked test, then stamp fidelity-pass " +
  `(mark.mjs fidelity-pass --feature-id ${feature} --task-id ${task}) ` +
  "before dispatching the executor cheap-hand.";

test("decidePiRunHandSpawn: descriptor ilegível/inválido é fail-CLOSED com a mensagem da lane OC", () => {
  for (const descriptor of [null, undefined, [], "x", { feature_id: "f" }, { feature_id: 1, task_id: "t" }]) {
    const d = decidePiRunHandSpawn({ descriptorPath: "/tmp/d.json", descriptor });
    assert.equal(d.ok, false, JSON.stringify(descriptor));
    assert.equal(d.decision, "deny");
    assert.equal(d.reason, UNREADABLE_DENY("/tmp/d.json"));
  }
});

test("decidePiRunHandSpawn: executor sem fidelity_pass do par exato é negado com a mensagem da lane OC", () => {
  const descriptor = { feature_id: "feat-a", task_id: "task-1", role: "harness-executor-high" };
  const denied = decidePiRunHandSpawn({ descriptorPath: "/tmp/d.json", descriptor, gateState: { fidelity_pass: ["feat-a/task-2@abc"] } });
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, FIDELITY_DENY("feat-a", "task-1"));

  const allowed = decidePiRunHandSpawn({ descriptorPath: "/tmp/d.json", descriptor, gateState: { fidelity_pass: ["feat-a/task-1@abc"] } });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.reason, "spawn-hand-fidelity-ok");
});

test("decidePiRunHandSpawn: test-author e sniper são isentos (o test-author produz o fato)", () => {
  for (const role of ["harness-test-author", "harness-sniper-high"]) {
    const d = decidePiRunHandSpawn({
      descriptorPath: "/tmp/d.json",
      descriptor: { feature_id: "feat-a", task_id: "task-1", role },
      gateState: {},
    });
    assert.equal(d.ok, true, role);
    assert.equal(d.reason, "spawn-hand-fidelity-exempt");
  }
});

// ---- tool nativa run_hand ----

test("createPiRunHandTool: descriptor ausente bloqueia e nada é despachado", async () => {
  let dispatched = false;
  const tool = createPiRunHandTool({
    projectRoot: "/proj",
    readGateState: () => ({}),
    runHandFn: async () => {
      dispatched = true;
      return { ok: true, outcome: OUTCOME.DONE };
    },
  });
  const denial = tool.authorize({ toolName: RUN_HAND_TOOL_NAME, input: {}, sessionId: "ses-1", toolCallId: "call-1" });
  assert.equal(denial.ok, false);
  assert.equal(denial.block, true);
  assert.equal(denial.reason, UNREADABLE_DENY(""));
  assert.equal(tool.pendingCount(), 0);

  const result = await tool.execute({ toolCallId: "call-1", sessionId: "ses-1" });
  assert.equal(result.ok, false);
  assert.match(result.output, /authorization missing/);
  assert.equal(dispatched, false);
});

test("createPiRunHandTool: ignora outras tools e nega executor sem fidelity antes de qualquer spawn", () => {
  const descriptor = { feature_id: "feat-a", task_id: "task-1", role: "harness-executor-medium" };
  const tool = createPiRunHandTool({
    projectRoot: "/proj",
    readDescriptor: () => descriptor,
    readGateState: () => ({ fidelity_pass: [] }),
  });
  assert.equal(tool.authorize({ toolName: "bash", input: {}, sessionId: "s", toolCallId: "c" }), undefined);

  const denial = tool.authorize({
    toolName: RUN_HAND_TOOL_NAME,
    input: { descriptor: "/tmp/d.json" },
    sessionId: "ses-1",
    toolCallId: "call-2",
  });
  assert.equal(denial.ok, false);
  assert.equal(denial.reason, FIDELITY_DENY("feat-a", "task-1"));
});

test("createPiRunHandTool: autorização é consumida uma única vez e a sessão do runtime vence o descriptor", async () => {
  const calls = [];
  const tool = createPiRunHandTool({
    projectRoot: "/proj",
    readDescriptor: () => ({ feature_id: "feat-a", task_id: "task-1", role: "harness-test-author", session_id: "forjada" }),
    readGateState: () => ({}),
    runHandFn: async (descriptor) => {
      calls.push(descriptor);
      return { ok: true, outcome: OUTCOME.DONE, recordPath: "/rec.json" };
    },
  });
  assert.equal(tool.authorize({ toolName: RUN_HAND_TOOL_NAME, input: { descriptor: "/tmp/d.json" }, sessionId: "ses-real", toolCallId: "call-3" }).ok, true);
  assert.equal(tool.pendingCount(), 1);

  const first = await tool.execute({ toolCallId: "call-3", sessionId: "ses-real" });
  assert.equal(first.ok, true);
  assert.equal(first.metadata.outcome, OUTCOME.DONE);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].session_id, "ses-real");
  assert.equal(calls[0].project_root, "/proj");

  const replay = await tool.execute({ toolCallId: "call-3", sessionId: "ses-real" });
  assert.equal(replay.ok, false);
  assert.match(replay.output, /authorization missing/);
  assert.equal(calls.length, 1);
});

// ---- runPiHand ponta a ponta ----

test("runPiHand: executor sem fidelity_pass em disco → CONFIG_ERROR antes do spawn", async () => {
  const fx = piHandFixture({ prefix: "pi-run-hand-fid-" });
  try {
    let spawned = false;
    const result = await runPiHand({
      feature_id: fx.featureId,
      task_id: fx.taskId,
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "freeze1",
      role: "harness-executor-medium",
      model: HAND_MODEL,
      no_tests: true,
      brief: "do work",
    }, {
      agentsDir: fx.agentsDir,
      spawn: async () => {
        spawned = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(result.outcome, OUTCOME.CONFIG_ERROR);
    assert.match(result.reason, /fidelity-pass missing for feat-pi-hand\/task-1/);
    assert.equal(spawned, false);

    // O fato carimbado em disco libera o gate (fidelity exige o par EXATO feature/task).
    const gp = piGateStatePath({ projectRoot: fx.root, sessionId: fx.sessionId });
    assert.equal(defaultHasPiFidelityPass({ projectRoot: fx.root, sessionId: fx.sessionId, featureId: fx.featureId, taskId: fx.taskId }), false);
    assert.equal(mergeGateState(gp.path, { fidelity_pass: [`${fx.featureId}/${fx.taskId}@abc`] }).ok, true);
    assert.equal(defaultHasPiFidelityPass({ projectRoot: fx.root, sessionId: fx.sessionId, featureId: fx.featureId, taskId: fx.taskId }), true);
    assert.equal(defaultHasPiFidelityPass({ projectRoot: fx.root, sessionId: fx.sessionId, featureId: fx.featureId, taskId: "outra" }), false);
  } finally {
    fx.close();
  }
});

test("runPiHand: modelo fora de openai-codex/* é CONFIG_ERROR antes do spawn", async () => {
  const fx = piHandFixture({ prefix: "pi-run-hand-model-" });
  try {
    let spawned = false;
    const result = await runPiHand({
      feature_id: fx.featureId,
      task_id: fx.taskId,
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "freeze1",
      role: "harness-test-author",
      model: "anthropic/claude-opus",
      no_tests: true,
      brief: "x",
    }, {
      agentsDir: fx.agentsDir,
      spawn: async () => {
        spawned = true;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    assert.equal(result.outcome, OUTCOME.CONFIG_ERROR);
    assert.match(result.reason, /only openai-codex\/\* routes are approved/);
    assert.equal(spawned, false);
  } finally {
    fx.close();
  }
});

test("runPiHand: escopo violado vira NON-DONE, reseta a worktree e grava o record sob .pi/harness/state", async () => {
  const fx = piHandFixture({ prefix: "pi-run-hand-scope-" });
  try {
    const deleted = [];
    let resetSha = null;
    let phase = "pre";
    const untrackedByPhase = { pre: [], post: ["outside/evil.ts"] };

    const result = await runPiHand({
      feature_id: fx.featureId,
      task_id: fx.taskId,
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "freeze99",
      role: "harness-executor-medium",
      model: HAND_MODEL,
      no_tests: true,
      brief: "do work",
    }, {
      agentsDir: fx.agentsDir,
      dispatchCallId: () => "call-run",
      checkFidelityPass: () => true,
      spawn: async ({ agent, model, dispatchAuthority }) => {
        assert.equal(agent, "harness-executor");
        assert.equal(model, HAND_MODEL);
        assert.deepEqual(dispatchAuthority, { sessionId: fx.sessionId, callId: "call-run" });
        const dispatch = JSON.parse(fs.readFileSync(dispatchRecordPath(fx.stateDir, "call-run"), "utf8"));
        assert.equal(dispatch.parent_session_id, fx.sessionId);
        assert.equal(dispatch.feature_id, fx.featureId);
        assert.equal(dispatch.task_id, fx.taskId);
        assert.equal(dispatch.role, "harness-executor-medium");
        assert.deepEqual(dispatch.scope_paths, ["src"]);
        phase = "post";
        return { exitCode: 0, stdout: "I am DONE", stderr: "" };
      },
      git: {
        headSha: () => "freeze99",
        diffNameOnly: () => ["outside/evil.ts"],
        lsFilesOthers: () => untrackedByPhase[phase] ?? [],
      },
      lsUntracked: () => untrackedByPhase[phase] ?? [],
      gitResetHard: (sha) => {
        resetSha = sha;
        return { ok: true };
      },
      removePath: (rel) => {
        deleted.push(rel);
        return { ok: true };
      },
      writePath: () => ({ ok: true }),
      isDirtyVsFreeze: () => true,
    });

    assert.equal(result.outcome, OUTCOME.FAILED);
    assert.notEqual(result.outcome, OUTCOME.DONE);
    // Prosa "I am DONE" + exit 0 não fazem DONE: o oráculo é independente.
    assert.equal(result.processExitCode, 0);
    assert.equal(resetSha, "freeze99");
    assert.equal(result.worktree.cleaned, true);
    assert.ok(deleted.includes("outside/evil.ts"));
    assert.ok(result.details.scopeViolations.includes("outside/evil.ts"));

    assert.ok(result.recordPath.includes(path.join(".pi", "harness", "state", "hand-records", fx.featureId, fx.sessionId, "task-1.json")));
    const onDisk = JSON.parse(fs.readFileSync(result.recordPath, "utf8"));
    assert.equal(onDisk.writtenBy, "run-hand-adapter");
    assert.equal(onDisk.agent, "harness-executor-medium");
    assert.equal(onDisk.freezeCommitSha, "freeze99");
    assert.equal(onDisk.producerCallId, "call-run");
    // Não-DONE devolve o dispatch-record; DONE o retém até a captura do pai.
    assert.equal(fs.existsSync(dispatchRecordPath(fx.stateDir, "call-run")), false);
  } finally {
    fx.close();
  }
});

test("runPiHand: teste congelado alterado é barrado por checkFrozen mesmo com a suíte verde", async () => {
  const fx = piHandFixture({ prefix: "pi-run-hand-frozen-" });
  try {
    const result = await runPiHand({
      feature_id: fx.featureId,
      task_id: fx.taskId,
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "freeze-frozen",
      role: "harness-executor-high",
      model: HAND_MODEL,
      brief: "implement",
      locked_test: "tests/foo.test.mjs",
      frozen_paths: ["tests/foo.test.mjs"],
    }, {
      agentsDir: fx.agentsDir,
      dispatchCallId: () => "call-frozen",
      checkFidelityPass: () => true,
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      git: {
        headSha: () => "freeze-frozen",
        diffNameOnly: () => ["src/a.ts", "tests/foo.test.mjs"],
        lsFilesOthers: () => [],
      },
      testRunner: () => ({ stdout: "# tests 7\n# pass 7\n# fail 0\n", stderr: "", exitCode: 0 }),
      lsUntracked: () => [],
      gitResetHard: () => ({ ok: true }),
      removePath: () => ({ ok: true }),
      writePath: () => ({ ok: true }),
      isDirtyVsFreeze: () => true,
    });

    assert.equal(result.outcome, OUTCOME.FAILED);
    assert.ok(result.details.frozenViolations.includes("tests/foo.test.mjs"));
    // Contagem de testes parseada da saída real do runner (parseTestsCount).
    assert.equal(result.child.testsCount, 7);
    assert.equal(result.child.lockedTestExitCode, 0);
  } finally {
    fx.close();
  }
});

test("runPiHand: verde vacuoso (0 testes) força saída não-zero do teste travado → FAILED", async () => {
  const fx = piHandFixture({ prefix: "pi-run-hand-vacuous-" });
  try {
    const result = await runPiHand({
      feature_id: fx.featureId,
      task_id: fx.taskId,
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "freeze-vac",
      role: "harness-executor-high",
      model: HAND_MODEL,
      brief: "implement",
      locked_test: "tests/foo.test.mjs",
    }, {
      agentsDir: fx.agentsDir,
      dispatchCallId: () => "call-vac",
      checkFidelityPass: () => true,
      spawn: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      git: {
        headSha: () => "freeze-vac",
        diffNameOnly: () => ["src/a.ts"],
        lsFilesOthers: () => [],
      },
      testRunner: () => ({ stdout: "# tests 0\n", stderr: "", exitCode: 0 }),
      lsUntracked: () => [],
      gitResetHard: () => ({ ok: true }),
      removePath: () => ({ ok: true }),
      writePath: () => ({ ok: true }),
      isDirtyVsFreeze: () => true,
    });

    assert.equal(result.outcome, OUTCOME.FAILED);
    assert.equal(result.child.testsCount, 0);
    assert.equal(result.child.lockedTestExitCode, VACUOUS_GREEN_EXIT);
  } finally {
    fx.close();
  }
});

test("runPiHand: DONE retém o dispatch-record do produtor e grava producerCallId", async () => {
  const fx = piHandFixture({ prefix: "pi-run-hand-done-" });
  try {
    const result = await runPiHand({
      feature_id: fx.featureId,
      task_id: fx.taskId,
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "freeze-done",
      role: "harness-test-author",
      model: HAND_MODEL,
      no_tests: true,
      brief: "write the locked test",
    }, {
      agentsDir: fx.agentsDir,
      dispatchCallId: () => "call-done",
      checkFidelityPass: () => {
        throw new Error("test-author must not consult fidelity-pass");
      },
      spawn: async ({ agent }) => {
        assert.equal(agent, "harness-test-author");
        return { exitCode: 3, stdout: "", stderr: "" };
      },
      git: {
        headSha: () => "freeze-done",
        diffNameOnly: () => ["tests/foo.test.mjs"],
        lsFilesOthers: () => [],
      },
      lsUntracked: () => [],
      isDirtyVsFreeze: () => false,
    });

    assert.equal(result.outcome, OUTCOME.DONE);
    // Exit code 3 do processo não impede DONE — o oráculo é a captura, não o exit.
    assert.equal(result.processExitCode, 3);
    assert.equal(result.record.producerCallId, "call-done");
    assert.equal(result.record.freezeCommitSha, "freeze-done");
    assert.equal(result.worktree.kept, true);
    assert.equal(fs.existsSync(dispatchRecordPath(fx.stateDir, "call-done")), true);
  } finally {
    fx.close();
  }
});

test("runPiHand: falha de reset marca hand_quarantine no gate-state e o segundo spawn é negado", async () => {
  const fx = piHandFixture({ prefix: "pi-run-hand-quarantine-" });
  try {
    const deps = (calls) => ({
      agentsDir: fx.agentsDir,
      dispatchCallId: () => `call-${calls.length}`,
      checkFidelityPass: () => true,
      spawn: async () => {
        calls.push("spawn");
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      git: {
        headSha: () => "outro-head",
        diffNameOnly: () => [],
        lsFilesOthers: () => [],
      },
      lsUntracked: () => [],
      gitResetHard: () => ({ ok: false, reason: "reset impossible" }),
      removePath: () => ({ ok: true }),
      writePath: () => ({ ok: true }),
      isDirtyVsFreeze: () => true,
    });

    const calls = [];
    const descriptor = {
      feature_id: fx.featureId,
      task_id: fx.taskId,
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "freeze-q",
      role: "harness-executor-medium",
      model: HAND_MODEL,
      no_tests: true,
      brief: "do work",
    };

    const first = await runPiHand(descriptor, deps(calls));
    assert.equal(first.outcome, OUTCOME.CAPTURE_ERROR);
    assert.equal(first.worktree.hand_quarantine, true);
    assert.equal(calls.length, 1);
    assert.equal(defaultIsPiHandQuarantined({ projectRoot: fx.root, sessionId: fx.sessionId, featureId: fx.featureId, taskId: fx.taskId }), true);

    const second = await runPiHand(descriptor, deps(calls));
    assert.equal(second.outcome, OUTCOME.CONFIG_ERROR);
    assert.match(second.reason, /hand_quarantine active for feat-pi-hand\/task-1 — deny spawn until orchestrator clears marker/);
    assert.equal(calls.length, 1, "quarentena impede o segundo spawn");
  } finally {
    fx.close();
  }
});

test("runPiHand: papel não-spawnável e freeze ausente falham fechado com as mensagens da lane OC", async () => {
  const noFreeze = await runPiHand({
    feature_id: "f",
    task_id: "t",
    session_id: "s",
    project_root: "/tmp",
    role: "harness-executor-medium",
    model: HAND_MODEL,
  }, { spawn: async () => ({ exitCode: 0 }) });
  assert.equal(noFreeze.outcome, OUTCOME.CONFIG_ERROR);
  assert.equal(noFreeze.reason, "freeze_commit_sha is required");

  const badRole = await runPiHand({
    feature_id: "f",
    task_id: "t",
    session_id: "s",
    project_root: "/tmp",
    freeze_commit_sha: "abc",
    role: "harness-planner",
    model: HAND_MODEL,
  }, { spawn: async () => ({ exitCode: 0 }) });
  assert.equal(badRole.outcome, OUTCOME.CONFIG_ERROR);
  assert.equal(badRole.reason, "role harness-planner: not a CLI-spawnable hand");

  const noIds = await runPiHand({}, { spawn: async () => ({ exitCode: 0 }) });
  assert.equal(noIds.reason, "feature_id, task_id, and session_id are required");
});

test("runPiHand: fix mode recusa freeze do descriptor divergente da autoridade e não deixa dispatch-record", async () => {
  // Espelha 'runHand: fix-mode rejects a descriptor freeze SHA that differs from host authority'
  // (lane OC): a autoridade do host vence o descriptor, nada é spawnado e o record reivindicado
  // é removido — senão a chamada seguinte colidiria com um claim órfão.
  const fx = piHandFixture({ prefix: "pi-run-hand-fixsha-", roles: ["harness-sniper"] });
  try {
    const reviewedSha = "abc123abc123abc123abc123abc123abc123abcd";
    fs.writeFileSync(path.join(fx.root, "src", "fix.ts"), "before\n");
    // fix mode dispensa o plano, mas exige gate-state classificado LIGHT/FULL da mesma sessão.
    fs.writeFileSync(path.join(fx.stateDir, "gate-state.json"), JSON.stringify({
      session_id: fx.sessionId,
      feature_id: fx.featureId,
      mode: "LIGHT",
      classified: true,
    }));

    let spawned = false;
    const result = await runPiHand({
      feature_id: fx.featureId,
      task_id: "fix-task",
      session_id: fx.sessionId,
      project_root: fx.root,
      freeze_commit_sha: "deadbeef",
      role: "harness-sniper-low",
      model: HAND_MODEL,
      no_tests: true,
      brief: "repair",
    }, {
      agentsDir: fx.agentsDir,
      dispatchCallId: () => "run-hand:fix-sha",
      dispatchEnvironment: {
        HARNESS_FIX_MODE: "1",
        HARNESS_FIX_SCOPE_JSON: JSON.stringify({ version: 1, reviewed_sha: reviewedSha, scope_paths: ["src/fix.ts"] }),
      },
      isReviewedShaAncestor: () => true,
      spawn: async () => { spawned = true; return { exitCode: 0, stdout: "", stderr: "" }; },
      lsUntracked: () => [],
      isDirtyVsFreeze: () => false,
    });

    assert.equal(result.outcome, OUTCOME.CONFIG_ERROR);
    assert.match(result.reason, /freeze sha conflicts with fix-mode authority/);
    assert.equal(spawned, false);
    assert.equal(fs.existsSync(dispatchRecordPath(fx.stateDir, "run-hand:fix-sha")), false);
  } finally {
    fx.close();
  }
});
