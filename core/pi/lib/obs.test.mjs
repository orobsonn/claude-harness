/**
 * @description Testes travados dos observadores da lane Pi. Espelham os casos do teste OC
 * (core/opencode/plugin/obs-eye.test.mjs e obs-hand.test.mjs) com a raiz `.pi/harness/`:
 * caminho de plano/spec, papel `harness-adversary` reconhecido como olho, mão sem taskId que
 * não emite e fail-open total (erro de leitura nunca lança, nunca bloqueia).
 */
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  isPiWritingHand,
  observePiEyeVerdict,
  observePiHandCompletion,
  observePiPlanWrite,
  observePiTaskExecuting,
  piEventForPlanPath,
  piFeatureFromPlanPath,
  piFeatureIdForSession,
  piFullPlanExistsForRun,
  piPlanDirForRun,
  piResultText,
} from "./obs.mjs";

const SESSION = "ses-obs-pi";
const FEATURE = "obs-pi";

/** @description Coletor de eventos que substitui obsAppend nos testes (nada toca o outbox real). */
function collector() {
  const events = [];
  return {
    events,
    obsAppend: (event) => {
      events.push(event);
      return true;
    },
  };
}

/** @description Raiz temporária de projeto, sempre removida ao fim. */
async function withTempRoot(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-obs-"));
  try {
    await fn(root);
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** @description Escreve o gate-state Pi da sessão com o feature_id classificado. */
function writeGateState(root, sessionId, featureId) {
  const dir = path.join(root, ".pi", "harness", "state", sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "gate-state.json"),
    JSON.stringify({ session_id: sessionId, feature_id: featureId, classified: true, mode: "FULL" }),
    "utf8",
  );
}

/** @description Escreve o plano estável Pi da feature. */
function writePlan(root, featureId, tasks) {
  const dir = path.join(root, ".pi", "harness", "plans", featureId);
  fs.mkdirSync(dir, { recursive: true });
  const planPath = path.join(dir, "execution-plan.json");
  fs.writeFileSync(planPath, JSON.stringify({ feature_id: featureId, mode: "full", tasks }), "utf8");
  return planPath;
}

// --------------------------------------------------------------------------------------------
// piEventForPlanPath / piFeatureFromPlanPath
// --------------------------------------------------------------------------------------------

test("piEventForPlanPath reconhece os dois caminhos Pi e ignora .opencode", () => {
  assert.deepEqual(piEventForPlanPath(".pi/harness/plans/obs-pi/execution-plan.json"), {
    type: "plan-created",
  });
  assert.deepEqual(piEventForPlanPath("/abs/repo/.pi/harness/plans/obs-pi/spec.md"), {
    type: "spec-created",
  });
  assert.equal(piEventForPlanPath(".opencode/plans/obs-pi/execution-plan.json"), null);
  assert.equal(piEventForPlanPath(".opencode/plans/obs-pi/spec.md"), null);
});

test("piEventForPlanPath ignora estado, caminhos fora de plans e entradas inválidas", () => {
  assert.equal(piEventForPlanPath(".pi/harness/state/ses/gate-state.json"), null);
  assert.equal(piEventForPlanPath(".pi/harness/plans/.state/ses/gate-state.json"), null);
  assert.equal(piEventForPlanPath(".pi/plans/obs-pi/execution-plan.json"), null);
  assert.equal(piEventForPlanPath("src/index.ts"), null);
  assert.equal(piEventForPlanPath(null), null);
  assert.equal(piEventForPlanPath(42), null);
});

test("piEventForPlanPath aceita separador Windows e spec.json", () => {
  assert.deepEqual(piEventForPlanPath("C:\\repo\\.pi\\harness\\plans\\obs-pi\\execution-plan.json"), {
    type: "plan-created",
  });
  assert.deepEqual(piEventForPlanPath(".pi/harness/plans/obs-pi/spec.json"), {
    type: "spec-created",
  });
});

test("piFeatureFromPlanPath extrai a feature só dos arquivos canônicos Pi", () => {
  assert.deepEqual(piFeatureFromPlanPath("/repo/.pi/harness/plans/obs-pi/execution-plan.json"), {
    featureId: "obs-pi",
  });
  assert.deepEqual(piFeatureFromPlanPath(".pi/harness/plans/obs-pi/spec.md"), { featureId: "obs-pi" });
  assert.equal(piFeatureFromPlanPath(".opencode/plans/obs-pi/spec.md"), null);
  assert.equal(piFeatureFromPlanPath(".pi/harness/plans/obs-pi/notes.md"), null);
  assert.equal(piFeatureFromPlanPath(undefined), null);
});

test("piPlanDirForRun devolve a raiz Pi e null para identidade insegura", () => {
  assert.equal(piPlanDirForRun("/repo", FEATURE), `/repo/.pi/harness/plans/${FEATURE}`);
  assert.equal(piPlanDirForRun("/repo", "../escape"), null);
  assert.equal(piPlanDirForRun("", FEATURE), null);
});

// --------------------------------------------------------------------------------------------
// piFeatureIdForSession / piFullPlanExistsForRun
// --------------------------------------------------------------------------------------------

test("piFeatureIdForSession prefere a feature declarada e cai no gate-state Pi", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    assert.equal(
      piFeatureIdForSession({ projectRoot: root, sessionId: SESSION, featureId: "declarada" }),
      "declarada",
    );
    assert.equal(piFeatureIdForSession({ projectRoot: root, sessionId: SESSION }), FEATURE);
    assert.equal(piFeatureIdForSession({ projectRoot: root, sessionId: "outra-sessao" }), "");
    assert.equal(piFeatureIdForSession({ projectRoot: root }), "");
  });
});

test("piFullPlanExistsForRun exige plano com tasks sob .pi/harness/plans", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    assert.equal(piFullPlanExistsForRun({ projectRoot: root, sessionId: SESSION }), false);

    writePlan(root, FEATURE, []);
    assert.equal(piFullPlanExistsForRun({ projectRoot: root, sessionId: SESSION }), false);

    writePlan(root, FEATURE, [{ id: "t1" }]);
    assert.equal(piFullPlanExistsForRun({ projectRoot: root, sessionId: SESSION }), true);
    // Sem feature nenhuma fecha em false — igual à lane OC.
    assert.equal(piFullPlanExistsForRun({ projectRoot: root, sessionId: null }), false);
  });
});

test("piFullPlanExistsForRun é fail-open quando a leitura estoura", () => {
  const boom = () => {
    throw new Error("EIO");
  };
  assert.equal(
    piFullPlanExistsForRun({
      projectRoot: "/repo",
      sessionId: SESSION,
      featureId: FEATURE,
      existsSync: () => true,
      readFileSync: boom,
    }),
    false,
  );
});

// --------------------------------------------------------------------------------------------
// obs-hand
// --------------------------------------------------------------------------------------------

test("observePiTaskExecuting indexa a task pelo plano estável Pi", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    writePlan(root, FEATURE, [{ id: "t0" }, { id: "t1" }, { id: "t2" }]);
    const sink = collector();
    const event = observePiTaskExecuting(
      { projectRoot: root, sessionId: SESSION, role: "harness-executor-high", taskId: "t1" },
      { obsAppend: sink.obsAppend },
    );
    assert.deepEqual(event, { type: "task-executing", n: 2, total: 3 });
    assert.deepEqual(sink.events, [{ type: "task-executing", n: 2, total: 3 }]);
  });
});

test("observePiTaskExecuting: mão sem taskId não emite", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    writePlan(root, FEATURE, [{ id: "t0" }]);
    const sink = collector();
    assert.equal(
      observePiTaskExecuting(
        { projectRoot: root, sessionId: SESSION, role: "harness-sniper-high", taskId: "" },
        { obsAppend: sink.obsAppend },
      ),
      null,
    );
    assert.deepEqual(sink.events, []);
  });
});

test("observePiTaskExecuting ignora papel que não é mão, sessão vazia e task fora do plano", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    writePlan(root, FEATURE, [{ id: "t0" }]);
    const sink = collector();
    const deps = { obsAppend: sink.obsAppend };
    assert.equal(
      observePiTaskExecuting({ projectRoot: root, sessionId: SESSION, role: "harness-adversary", taskId: "t0" }, deps),
      null,
    );
    assert.equal(
      observePiTaskExecuting({ projectRoot: root, sessionId: "", role: "harness-executor", taskId: "t0" }, deps),
      null,
    );
    assert.equal(
      observePiTaskExecuting({ projectRoot: root, sessionId: SESSION, role: "harness-executor", taskId: "ausente" }, deps),
      null,
    );
    assert.deepEqual(sink.events, []);
  });
});

test("observePiTaskExecuting não lança quando a leitura do plano estoura", () => {
  const sink = collector();
  const boom = () => {
    throw new Error("EIO");
  };
  assert.doesNotThrow(() => {
    const event = observePiTaskExecuting(
      { projectRoot: "/repo", sessionId: SESSION, role: "harness-executor", taskId: "t0", featureId: FEATURE },
      { obsAppend: sink.obsAppend, existsSync: () => true, readFileSync: boom },
    );
    assert.equal(event, null);
  });
  assert.deepEqual(sink.events, []);
});

test("observePiHandCompletion emite hand-ran só quando a conclusão é terminal", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    const calls = [];
    const record = (input) => {
      calls.push(input);
      return { ok: true, terminal: true, recorded: true };
    };
    const event = observePiHandCompletion(
      {
        projectRoot: root,
        sessionId: SESSION,
        role: "harness-executor-high",
        taskId: "t1",
        producerCallId: "call-1",
        outputText: "STATUS: DONE",
        model: "openai-codex/gpt-5.6",
      },
      { obsAppend: sink.obsAppend, recordCompletion: record },
    );
    assert.deepEqual(event, { type: "hand-ran", task: "t1", model: "openai-codex/gpt-5.6" });
    assert.equal(calls.length, 1);
    // A feature vem do gate-state Pi, não do dispatch.
    assert.equal(calls[0].featureId, FEATURE);
    assert.equal(calls[0].producerCallId, "call-1");
  });
});

test("observePiHandCompletion não emite quando a mão de background ainda roda", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    const event = observePiHandCompletion(
      {
        projectRoot: root,
        sessionId: SESSION,
        role: "harness-executor",
        taskId: "t1",
        producerCallId: "call-1",
        background: true,
      },
      {
        obsAppend: sink.obsAppend,
        recordCompletion: () => ({ ok: true, terminal: false, recorded: false }),
      },
    );
    assert.equal(event, null);
    assert.deepEqual(sink.events, []);
  });
});

test("observePiHandCompletion exige mão escritora, taskId, callId e feature", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    const record = () => ({ ok: true, terminal: true, recorded: true });
    const deps = { obsAppend: sink.obsAppend, recordCompletion: record };
    const base = {
      projectRoot: root,
      sessionId: SESSION,
      role: "harness-executor",
      taskId: "t1",
      producerCallId: "call-1",
    };
    assert.equal(observePiHandCompletion({ ...base, role: "harness-adversary" }, deps), null);
    assert.equal(observePiHandCompletion({ ...base, taskId: "" }, deps), null);
    assert.equal(observePiHandCompletion({ ...base, producerCallId: "" }, deps), null);
    assert.equal(observePiHandCompletion({ ...base, sessionId: "sem-gate-state" }, deps), null);
    assert.deepEqual(sink.events, []);
  });
});

test("observePiHandCompletion é fail-open quando o registro de conclusão estoura", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    assert.doesNotThrow(() => {
      const event = observePiHandCompletion(
        {
          projectRoot: root,
          sessionId: SESSION,
          role: "harness-sniper-high",
          taskId: "t1",
          producerCallId: "call-1",
        },
        {
          obsAppend: sink.obsAppend,
          recordCompletion: () => {
            throw new Error("gate-state lock failed");
          },
        },
      );
      assert.equal(event, null);
    });
    assert.deepEqual(sink.events, []);
  });
});

test("isPiWritingHand reconhece as três famílias de mão escritora do Pi", () => {
  assert.equal(isPiWritingHand("harness-executor-high"), true);
  assert.equal(isPiWritingHand("harness-sniper"), true);
  assert.equal(isPiWritingHand("harness-test-author"), true);
  assert.equal(isPiWritingHand("harness-planner"), false);
  assert.equal(isPiWritingHand("harness-adversary"), false);
  assert.equal(isPiWritingHand(null), false);
});

// --------------------------------------------------------------------------------------------
// obs-eye
// --------------------------------------------------------------------------------------------

test("harness-adversary é reconhecido como olho: spec-adversary sem plano, eye com plano", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    const before = observePiEyeVerdict(
      { projectRoot: root, sessionId: SESSION, role: "harness-adversary", responseText: '{"issues":[]}' },
      { obsAppend: sink.obsAppend },
    );
    assert.deepEqual(before, { type: "spec-adversary", role: "adversary" });

    writePlan(root, FEATURE, [{ id: "t1" }]);
    const after = observePiEyeVerdict(
      { projectRoot: root, sessionId: SESSION, role: "harness-adversary", responseText: '{"issues":[]}' },
      { obsAppend: sink.obsAppend },
    );
    assert.deepEqual(after, { type: "eye", role: "adversary" });
    assert.deepEqual(sink.events, [
      { type: "spec-adversary", role: "adversary" },
      { type: "eye", role: "adversary" },
    ]);
  });
});

test("harness-plan-reviewer emite o veredito curado idêntico à lane OC", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    const event = observePiEyeVerdict(
      {
        projectRoot: root,
        sessionId: SESSION,
        role: "harness-plan-reviewer",
        responseText: '{"verdict":"APPROVE","findings":[]}',
      },
      { obsAppend: sink.obsAppend },
    );
    assert.deepEqual(event, { type: "plan-reviewed", verdict: "APPROVE", role: "plan-reviewer" });
  });
});

test("observePiEyeVerdict ignora mãos e papéis desconhecidos", async () => {
  await withTempRoot(async (root) => {
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    const deps = { obsAppend: sink.obsAppend };
    assert.equal(
      observePiEyeVerdict({ projectRoot: root, sessionId: SESSION, role: "harness-executor-high" }, deps),
      null,
    );
    assert.equal(
      observePiEyeVerdict({ projectRoot: root, sessionId: SESSION, role: "harness-shipper" }, deps),
      null,
    );
    assert.equal(observePiEyeVerdict({ projectRoot: root, sessionId: SESSION, role: null }, deps), null);
    assert.deepEqual(sink.events, []);
  });
});

test("observePiEyeVerdict não lança quando a leitura do gate-state estoura", () => {
  const sink = collector();
  assert.doesNotThrow(() => {
    const event = observePiEyeVerdict(
      { projectRoot: "/repo", sessionId: SESSION, role: "harness-compliance", responseText: "ok" },
      {
        obsAppend: sink.obsAppend,
        existsSync: () => true,
        readFileSync: () => {
          throw new Error("EIO");
        },
      },
    );
    assert.deepEqual(event, { type: "eye", role: "compliance" });
  });
});

// --------------------------------------------------------------------------------------------
// obs-plan-write
// --------------------------------------------------------------------------------------------

test("observePiPlanWrite emite plan-created com sessão, feature e contagem de tasks", () => {
  const sink = collector();
  const event = observePiPlanWrite(
    {
      filePath: `/repo/.pi/harness/plans/${FEATURE}/execution-plan.json`,
      sessionId: SESSION,
      content: JSON.stringify({ tasks: [{ id: "t1" }, { id: "t2" }] }),
    },
    { obsAppend: sink.obsAppend },
  );
  assert.deepEqual(event, {
    type: "plan-created",
    session_id: SESSION,
    feature_id: FEATURE,
    tasks: 2,
  });
  assert.deepEqual(sink.events, [event]);
});

test("observePiPlanWrite emite spec-created e mantém o evento factual sem conteúdo parseável", () => {
  const sink = collector();
  const spec = observePiPlanWrite(
    { filePath: `.pi/harness/plans/${FEATURE}/spec.md`, sessionId: SESSION, content: "# spec" },
    { obsAppend: sink.obsAppend },
  );
  assert.deepEqual(spec, { type: "spec-created", session_id: SESSION, feature_id: FEATURE });

  const plan = observePiPlanWrite(
    { filePath: `.pi/harness/plans/${FEATURE}/execution-plan.json`, content: "<<not json>>" },
    { obsAppend: sink.obsAppend },
  );
  assert.deepEqual(plan, { type: "plan-created", feature_id: FEATURE });
});

test("observePiPlanWrite ignora escrita fora de .pi/harness/plans e entrada inválida", () => {
  const sink = collector();
  const deps = { obsAppend: sink.obsAppend };
  assert.equal(observePiPlanWrite({ filePath: "src/index.ts", sessionId: SESSION }, deps), null);
  assert.equal(
    observePiPlanWrite({ filePath: `.opencode/plans/${FEATURE}/execution-plan.json` }, deps),
    null,
  );
  assert.equal(observePiPlanWrite({ filePath: "" }, deps), null);
  assert.equal(observePiPlanWrite({}, deps), null);
  assert.deepEqual(sink.events, []);
});

// --------------------------------------------------------------------------------------------
// piResultText
// --------------------------------------------------------------------------------------------

test("piResultText normaliza as formas de resultado de tool do Pi", () => {
  assert.equal(piResultText("texto"), "texto");
  assert.equal(piResultText({ content: [{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }] }), "ab");
  assert.equal(piResultText({ output: "saida" }), "saida");
  assert.equal(piResultText(null), "");
  assert.equal(piResultText(undefined), "");
  assert.equal(piResultText({ verdict: "APPROVE" }), '{"verdict":"APPROVE"}');
});

// --------------------------------------------------------------------------------------------
// Registro terminal REAL (sem injeção): a lane Pi grava sob .pi/harness/state e nunca em .opencode
// --------------------------------------------------------------------------------------------

/** @description Escreve um dispatch-record Pi válido do produtor exato da task. */
function writeDispatchRecord(root, sessionId, callId, featureId, taskId, role) {
  const digest = crypto.createHash("sha256").update(callId).digest("hex");
  const dir = path.join(root, ".pi", "harness", "state", sessionId, "dispatch-records");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${digest}.json`),
    JSON.stringify({
      parent_session_id: sessionId,
      dispatch_call_id: callId,
      feature_id: featureId,
      task_id: taskId,
      role,
      plan_hash: "a".repeat(64),
      claimed_at: new Date().toISOString(),
      child_session_id: null,
      scope_paths: ["src"],
      allowed_writes: [],
      frozen_paths: [],
      worktree_baseline: null,
    }),
    "utf8",
  );
}

test("observePiHandCompletion (recorder default) grava o hand-record sob .pi/harness/state", async () => {
  await withTempRoot(async (tmp) => {
    const root = fs.realpathSync(tmp);
    writeGateState(root, SESSION, FEATURE);
    writeDispatchRecord(root, SESSION, "call-real", FEATURE, "t1", "harness-executor");
    const sink = collector();
    const event = observePiHandCompletion(
      {
        projectRoot: root,
        sessionId: SESSION,
        role: "harness-executor",
        taskId: "t1",
        producerCallId: "call-real",
        outputText: "Status: DONE",
      },
      { obsAppend: sink.obsAppend },
    );
    assert.deepEqual(event, { type: "hand-ran", task: "t1", model: "executor" });
    // O fato terminal vai para a raiz de estado da lane Pi...
    const handRecord = path.join(
      root, ".pi", "harness", "state", "hand-records", FEATURE, SESSION, "t1.json",
    );
    assert.equal(fs.existsSync(handRecord), true);
    assert.equal(JSON.parse(fs.readFileSync(handRecord, "utf8")).outcome, "DONE");
    // ...e o gate-state Pi é carimbado, como na lane OC.
    const gate = JSON.parse(
      fs.readFileSync(path.join(root, ".pi", "harness", "state", SESSION, "gate-state.json"), "utf8"),
    );
    assert.deepEqual(gate.hand_finished, [`${FEATURE}/t1`]);
    // Nenhum caminho da lane OC é tocado.
    assert.equal(fs.existsSync(path.join(root, ".opencode")), false);
  });
});

test("observePiHandCompletion (recorder default) é fail-open sem dispatch-record exato", async () => {
  await withTempRoot(async (tmp) => {
    const root = fs.realpathSync(tmp);
    writeGateState(root, SESSION, FEATURE);
    const sink = collector();
    const event = observePiHandCompletion(
      {
        projectRoot: root,
        sessionId: SESSION,
        role: "harness-sniper",
        taskId: "t1",
        producerCallId: "call-sem-registro",
        outputText: "Status: DONE",
      },
      { obsAppend: sink.obsAppend },
    );
    // Observação nunca some: o evento sai mesmo sem produtor exato...
    assert.deepEqual(event, { type: "hand-ran", task: "t1", model: "sniper" });
    // ...mas nada é forjado no estado.
    assert.equal(
      fs.existsSync(path.join(root, ".pi", "harness", "state", "hand-records")),
      false,
    );
    assert.equal(fs.existsSync(path.join(root, ".opencode")), false);
  });
});
