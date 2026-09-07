/** @description Recuperação de contexto na compactação — lane Pi. Espelha
 * `core/opencode/plugin/reinject-state.test.mjs` (mesmos casos, mesmas asserções), trocando a
 * raiz `.opencode/plans/` por `.pi/harness/`. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildPiSessionRecovery, encodeRecoveryPayload, MAX_REINJECT_BYTES } from "./session-state.mjs";
import * as ocSessionState from "../../opencode/plugin/lib/session-state.mjs";

const SESSION = "ses-stable-recovery";
const FEATURE = "stable-recovery";
const MODEL_STRATEGY = {
  hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
  planner: "openai/planner",
  "plan-reviewer": "openai/reviewer",
  compliance: "openai/compliance",
  adversary: "openai/adversary",
  security: "openai/security",
  shipper: "openai/shipper",
  harvester: "openai/harvester",
};

/**
 * @description Monta um projectRoot temporário com gate-state (e opcionalmente plano estável)
 * sob a raiz da lane Pi.
 * @param {{ withPlan?: boolean, state?: Record<string, unknown> }} [opts]
 */
function fixture({ withPlan = true, state } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-reinject-stable-")));
  const statePath = path.join(root, ".pi", "harness", "state", SESSION, "gate-state.json");
  const planPath = path.join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    JSON.stringify(state ?? { session_id: SESSION, feature_id: FEATURE, mode: "FULL", classified: true }),
  );
  if (withPlan) {
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(
      planPath,
      JSON.stringify({
        feature_id: FEATURE,
        kind: "full",
        mode: "full",
        model_strategy: MODEL_STRATEGY,
        tasks: ["one", "two"].map((id) => ({
          id: `task-${id}`,
          severity: "low",
          complexity: "low",
          scope_paths: ["src/index.ts"],
          criterion_refs: ["#ac-1"],
          locked_tests: [],
          no_tests: true,
          depends_on: [],
        })),
      }),
    );
  }
  return { root, statePath, planPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** @description Extrai o JSON de dentro dos delimitadores do envelope. */
function payload(context) {
  return JSON.parse(context.split("\n")[1]);
}

test("reusa o encoder puro da lane OC — mesmos símbolos, sem cópia", () => {
  assert.equal(encodeRecoveryPayload, ocSessionState.encodeRecoveryPayload);
  assert.equal(MAX_REINJECT_BYTES, ocSessionState.MAX_REINJECT_BYTES);
  assert.equal(MAX_REINJECT_BYTES, 8 * 1024);
});

test("compactação reporta o plano estável desta sessão sem inferir workflow", () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.statePath);
    const recovered = buildPiSessionRecovery(f.root, SESSION);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.statePath, f.statePath);
    assert.deepEqual(payload(recovered.context), {
      schema: "harness.compaction-recovery.v1",
      mode: "FULL",
      feature_id: FEATURE,
      canonical_plan_path: `.pi/harness/plans/${FEATURE}/execution-plan.json`,
      plan_available: true,
      total_tasks: 2,
    });
    assert.ok(recovered.context.startsWith("<HARNESS_RECOVERY_JSON>\n"));
    assert.ok(recovered.context.endsWith("\n</HARNESS_RECOVERY_JSON>"));
    assert.doesNotMatch(recovered.context, /next|phase|review|planner|capture|verdict/i);
    // A recuperação nunca escreve — o gate-state fica byte a byte igual.
    assert.deepEqual(fs.readFileSync(f.statePath), before);
  } finally {
    f.cleanup();
  }
});

test("plano ausente ou inválido degrada para os fatos de triagem, sem escolher ação", () => {
  for (const invalid of [false, true]) {
    const f = fixture({ withPlan: invalid });
    try {
      if (invalid) fs.writeFileSync(f.planPath, "{");
      const recovered = buildPiSessionRecovery(f.root, SESSION);
      assert.equal(recovered.ok, true);
      assert.equal(payload(recovered.context).plan_available, false);
      assert.equal(payload(recovered.context).total_tasks, 0);
      // O caminho canônico continua sendo reportado mesmo sem plano no disco.
      assert.equal(payload(recovered.context).canonical_plan_path, `.pi/harness/plans/${FEATURE}/execution-plan.json`);
    } finally {
      f.cleanup();
    }
  }
});

test("gate-state de outra sessão não é recuperado nem mutado", () => {
  const f = fixture();
  try {
    const before = fs.readFileSync(f.statePath);
    const recovered = buildPiSessionRecovery(f.root, "ses-other");
    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, "gate-state session identity mismatch");
    assert.deepEqual(fs.readFileSync(f.statePath), before);
  } finally {
    f.cleanup();
  }
});

test("gate-state cujo session_id não bate com o pedido é recusado", () => {
  const f = fixture({ state: { session_id: "ses-someone-else", feature_id: FEATURE, mode: "FULL" } });
  try {
    const recovered = buildPiSessionRecovery(f.root, SESSION);
    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, "gate-state session identity mismatch");
  } finally {
    f.cleanup();
  }
});

test("identidade de sessão inválida é fail-closed antes de qualquer leitura", () => {
  for (const bad of [undefined, null, "", "../escape", "ses id"]) {
    const recovered = buildPiSessionRecovery("/tmp", bad);
    assert.equal(recovered.ok, false);
    assert.equal(recovered.reason, "invalid session identity");
  }
  const noRoot = buildPiSessionRecovery("", SESSION);
  assert.equal(noRoot.ok, false);
  assert.equal(noRoot.reason, "invalid session identity");
});

test("feature_id ou mode inválidos no gate-state recusam a recuperação", () => {
  for (const state of [
    { session_id: SESSION, feature_id: "../escape", mode: "FULL" },
    { session_id: SESSION, feature_id: FEATURE, mode: "TURBO" },
    { session_id: SESSION, feature_id: FEATURE },
  ]) {
    const f = fixture({ withPlan: false, state });
    try {
      const recovered = buildPiSessionRecovery(f.root, SESSION);
      assert.equal(recovered.ok, false);
      assert.equal(recovered.reason, "invalid recovery identity");
    } finally {
      f.cleanup();
    }
  }
});

test("plano por symlink não vaza contexto — degrada para plan_available:false", () => {
  const f = fixture();
  const sibling = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-reinject-sibling-")));
  try {
    const outside = path.join(sibling, "plan.json");
    fs.writeFileSync(outside, fs.readFileSync(f.planPath));
    fs.rmSync(f.planPath);
    fs.symlinkSync(outside, f.planPath);
    const recovered = buildPiSessionRecovery(f.root, SESSION);
    assert.equal(recovered.ok, true);
    assert.equal(payload(recovered.context).plan_available, false);
    assert.equal(payload(recovered.context).total_tasks, 0);
  } finally {
    f.cleanup();
    fs.rmSync(sibling, { recursive: true, force: true });
  }
});

test("raiz alcançada por symlink é canonicalizada — a recuperação não some", () => {
  const f = fixture();
  const holder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-reinject-link-")));
  const linked = path.join(holder, "root-link");
  try {
    fs.symlinkSync(f.root, linked, "dir");
    // A lane OC recebe a raiz já realpath'd (resolveSessionProjectRoot); aqui o ctx.cwd do Pi pode
    // chegar por symlink (/tmp no macOS) e a recuperação tem de sobreviver a isso.
    const recovered = buildPiSessionRecovery(linked, SESSION);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.statePath, f.statePath);
    assert.deepEqual(payload(recovered.context), {
      schema: "harness.compaction-recovery.v1",
      mode: "FULL",
      feature_id: FEATURE,
      canonical_plan_path: `.pi/harness/plans/${FEATURE}/execution-plan.json`,
      plan_available: true,
      total_tasks: 2,
    });
  } finally {
    f.cleanup();
    fs.rmSync(holder, { recursive: true, force: true });
  }
});

test("raiz inexistente é fail-closed sem lançar", () => {
  const missing = path.join(os.tmpdir(), `pi-reinject-absent-${process.pid}-${Date.now()}`);
  const recovered = buildPiSessionRecovery(missing, SESSION);
  assert.equal(recovered.ok, false);
  assert.equal(recovered.reason, "invalid session identity");
});

test("envelope gigante trunca dentro do teto UTF-8 e mantém os delimitadores", () => {
  const context = encodeRecoveryPayload({ schema: "harness.compaction-recovery.v1", value: "界".repeat(20_000) });
  assert.ok(context);
  assert.ok(Buffer.byteLength(context, "utf8") <= MAX_REINJECT_BYTES);
  assert.equal(Buffer.from(context).toString("utf8"), context);
  assert.ok(context.startsWith("<HARNESS_RECOVERY_JSON>\n"));
  assert.ok(context.endsWith("\n</HARNESS_RECOVERY_JSON>"));
  assert.equal(payload(context).truncated, true);
  assert.equal(typeof payload(context).truncated_json_prefix, "string");
});

test("orçamento de bytes pequeno demais devolve null", () => {
  assert.equal(encodeRecoveryPayload({ schema: "harness.compaction-recovery.v1" }, 10), null);
  assert.equal(encodeRecoveryPayload({ schema: "harness.compaction-recovery.v1" }, 0), null);
});

test('new task pipeline recovers durable handles as observations and keeps local task identity', () => {
  const f = fixture({ state: { session_id: SESSION, feature_id: FEATURE, mode: 'FULL', task_pipeline_version: 1 } });
  try {
    const registryPath = path.join(f.root, '.pi/harness/state', SESSION, 'task-runs/index.json');
    fs.mkdirSync(path.dirname(registryPath), {recursive:true});
    fs.writeFileSync(registryPath,JSON.stringify({version:1,parent_session_id:SESSION,feature_id:FEATURE,tasks:{'task-one':{task_id:'task-one',attempt_id:'attempt-one',status:'running'}}}));
    const recovered = payload(buildPiSessionRecovery(f.root,SESSION).context);
    assert.equal(recovered.task_pipeline.kind,'global');
    assert.deepEqual(recovered.task_pipeline.handles,[{task_id:'task-one',attempt_id:'attempt-one',status:'running'}]);
    assert.match(recovered.task_pipeline.observation,/harness_tasks/);
    const state=JSON.parse(fs.readFileSync(f.statePath));state.task_run={task_id:'task-one',attempt_id:'attempt-one',parent_session_id:'global-parent'};fs.writeFileSync(f.statePath,JSON.stringify(state));
    const local=payload(buildPiSessionRecovery(f.root,SESSION).context);
    assert.equal(local.task_pipeline.kind,'task');
    assert.equal(local.task_pipeline.task_id,'task-one');
    assert.equal(local.task_pipeline.handles,undefined);
  } finally {f.cleanup();}
});
