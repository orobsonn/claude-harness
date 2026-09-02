/**
 * @description Testes da autoridade de marcadores da lane Pi. Espelham
 * core/opencode/plugin/marker-authority.test.mjs: cada pré-condição de mutação, o par
 * hook+tool (execute direto, clone, replay), a restrição de sessão PAI no capture-verified
 * e o caminho feliz (carimbo capturedVerifiedAt + remoção do dispatch-record do produtor).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiMarkerAuthority, MARKER_ACTIONS, markerResponse } from "./marker-authority.mjs";
import { piGateStatePath, piHandRecordPath } from "./pi-paths.mjs";
import {
  normalizeProjectPath,
  piDispatchRecordPath,
  readPiDispatchRecord,
  removePiDispatchRecord,
} from "./pi-state-records.mjs";

const SESSION = "ses-authority";
const FEATURE = "feature-authority";
const TASK = "task-one";
const PRODUCER_CALL = "task-call-one";
const SHA = "0123456789abcdef0123456789abcdef01234567";

const roots = [];

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-marker-authority-"));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/** @description Grava um gate-state cru sob .pi/harness/state/<session>/gate-state.json. */
function seedGateState(root, state = {}) {
  const resolved = piGateStatePath({ projectRoot: root, sessionId: SESSION });
  assert.equal(resolved.ok, true);
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  fs.writeFileSync(
    resolved.path,
    JSON.stringify({ session_id: SESSION, feature_id: FEATURE, ...state }, null, 2),
    "utf8",
  );
  return resolved.path;
}

function readGateState(root) {
  const resolved = piGateStatePath({ projectRoot: root, sessionId: SESSION });
  return JSON.parse(fs.readFileSync(resolved.path, "utf8"));
}

/** @description Grava um hand-record sob .pi/harness/state/hand-records/<feature>/<session>/<task>.json. */
function seedHandRecord(root, overrides = {}) {
  const resolved = piHandRecordPath({ projectRoot: root, sessionId: SESSION, featureId: FEATURE }, TASK);
  assert.equal(resolved.ok, true);
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  const record = {
    writtenBy: "host-hand-finished",
    featureId: FEATURE,
    taskId: TASK,
    sessionId: SESSION,
    agent: "executor",
    producerCallId: PRODUCER_CALL,
    freezeCommitSha: SHA,
    outcome: "DONE",
    ...overrides,
  };
  fs.writeFileSync(resolved.path, JSON.stringify(record, null, 2), "utf8");
  return resolved.path;
}

function readHandRecord(root) {
  const resolved = piHandRecordPath({ projectRoot: root, sessionId: SESSION, featureId: FEATURE }, TASK);
  return JSON.parse(fs.readFileSync(resolved.path, "utf8"));
}

/** @description Autoridade com dispatch-records falsos e git determinístico. */
function makeAuthority(root, overrides = {}) {
  const removals = [];
  const authority = createPiMarkerAuthority({
    projectRoot: root,
    readDispatchRecord: (_root, { parentSessionId, callId }) =>
      callId === PRODUCER_CALL && parentSessionId === SESSION
        ? {
            ok: true,
            record: {
              parent_session_id: SESSION,
              dispatch_call_id: PRODUCER_CALL,
              feature_id: FEATURE,
              task_id: TASK,
              role: "executor",
            },
          }
        : { ok: false, reason: "dispatch record absent" },
    removeDispatchRecord: (_root, ids) => {
      removals.push(ids);
      return { ok: true, removed: true };
    },
    resolveHeadSha: () => SHA,
    isAncestorSha: () => true,
    now: () => "2026-01-01T00:00:00.000Z",
    ...overrides,
  });
  return { authority, removals };
}

/** @description Fluxo nativo completo: hook autoriza e a tool executa com o MESMO objeto de args. */
function call(authority, args, { sessionId = SESSION, toolCallId = "call-authority", isChild = false } = {}) {
  const input = { ...args };
  const decision = authority.authorize({ toolName: "mark", input, sessionId, toolCallId });
  if (decision && decision.ok === false) return { blocked: decision, result: null };
  const result = authority.execute({ toolCallId, params: input, sessionId, isChild });
  return { blocked: null, result, input };
}

function reasonOf(result) {
  return JSON.parse(result.output).reason;
}

// ---------------------------------------------------------------- shape

test("o conjunto de ações é exatamente o da lane OC", () => {
  assert.deepEqual([...MARKER_ACTIONS].sort(), [
    "adversary_fired",
    "brainstormed",
    "capture-verified",
    "demo-done",
    "fidelity",
    "final-review",
    "hand-finished",
    "regate-passed",
    "regate-pending",
  ]);
  assert.equal(markerResponse(true).title, "mark: persisted");
  assert.equal(markerResponse(false, "x").title, "mark: rejected");
});

test("o hook ignora qualquer tool que não seja mark", () => {
  const root = makeRoot();
  const { authority } = makeAuthority(root);
  assert.equal(authority.authorize({ toolName: "bash", input: { command: "ls" }, sessionId: SESSION, toolCallId: "c1" }), undefined);
});

// ---------------------------------------------------------------- hook denials

test("o hook nega args não-objeto, ação desconhecida e IDs de runtime ausentes", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  assert.equal(
    authority.authorize({ toolName: "mark", input: null, sessionId: SESSION, toolCallId: "c1" }).reason,
    "[marker-authority] exact object args required",
  );
  assert.equal(
    authority.authorize({ toolName: "mark", input: ["brainstormed"], sessionId: SESSION, toolCallId: "c1" }).reason,
    "[marker-authority] exact object args required",
  );
  assert.equal(
    authority.authorize({ toolName: "mark", input: { action: "ship-it" }, sessionId: SESSION, toolCallId: "c1" }).reason,
    "[marker-authority] unknown privileged marker action",
  );
  assert.equal(
    authority.authorize({ toolName: "mark", input: { action: "brainstormed" }, sessionId: "", toolCallId: "c1" }).reason,
    "[marker-authority] runtime sessionID and callID required",
  );
  assert.equal(
    authority.authorize({ toolName: "mark", input: { action: "brainstormed" }, sessionId: SESSION, toolCallId: "" }).reason,
    "[marker-authority] runtime sessionID and callID required",
  );
});

test("o hook nega gate-state ausente, identidade divergente e feature_id inseguro", () => {
  const root = makeRoot();
  const { authority } = makeAuthority(root);
  assert.equal(
    authority.authorize({ toolName: "mark", input: { action: "brainstormed" }, sessionId: SESSION, toolCallId: "c1" }).reason,
    "[marker-authority] gate-state missing or unreadable",
  );

  seedGateState(root, { session_id: "ses-other" });
  assert.equal(
    authority.authorize({ toolName: "mark", input: { action: "brainstormed" }, sessionId: SESSION, toolCallId: "c2" }).reason,
    "[marker-authority] classified runtime identity required",
  );

  const resolved = piGateStatePath({ projectRoot: root, sessionId: SESSION });
  fs.writeFileSync(resolved.path, JSON.stringify({ session_id: SESSION, feature_id: "Feature Authority" }), "utf8");
  assert.equal(
    authority.authorize({ toolName: "mark", input: { action: "brainstormed" }, sessionId: SESSION, toolCallId: "c3" }).reason,
    "[marker-authority] safe feature_id required",
  );
});

test("o hook nega o mesmo objeto de args reautorizado e o mesmo toolCallId reautorizado", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  const input = { action: "brainstormed" };
  assert.deepEqual(authority.authorize({ toolName: "mark", input, sessionId: SESSION, toolCallId: "c1" }), { ok: true });
  assert.equal(
    authority.authorize({ toolName: "mark", input, sessionId: SESSION, toolCallId: "c2" }).reason,
    "[marker-authority] args object already authorized",
  );
  assert.equal(
    authority.authorize({ toolName: "mark", input: { action: "brainstormed" }, sessionId: SESSION, toolCallId: "c1" }).reason,
    "[marker-authority] args object already authorized",
  );
});

// ---------------------------------------------------------------- binding

test("execução direta da tool, sem passar pelo hook, é rejeitada e não escreve nada", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  const result = authority.execute({ toolCallId: "call-direct", params: { action: "brainstormed" }, sessionId: SESSION });
  assert.equal(result.ok, false);
  assert.equal(reasonOf(result), "marker authorization missing, cloned, replayed, or binding-mismatched");
  assert.equal(readGateState(root).brainstormed, undefined);
});

test("params não-objeto usa a reason do OC e queima a autorização", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  const input = { action: "brainstormed" };
  assert.deepEqual(authority.authorize({ toolName: "mark", input, sessionId: SESSION, toolCallId: "c1" }), { ok: true });
  for (const params of [null, "brainstormed", ["brainstormed"]]) {
    const denied = authority.execute({ toolCallId: "c1", params, sessionId: SESSION });
    assert.equal(reasonOf(denied), "exact before-hook args identity required");
  }
  // A autorização foi consumida na primeira tentativa: o objeto legítimo já não passa.
  assert.equal(
    reasonOf(authority.execute({ toolCallId: "c1", params: input, sessionId: SESSION })),
    "marker authorization missing, cloned, replayed, or binding-mismatched",
  );
  assert.equal(readGateState(root).brainstormed, undefined);
  assert.equal(authority.pendingCount(), 0);
});

test("gate-state com JSON válido mas não-objeto nega com a reason de identidade do OC", () => {
  const root = makeRoot();
  seedGateState(root);
  const resolved = piGateStatePath({ projectRoot: root, sessionId: SESSION });
  const { authority } = makeAuthority(root);
  for (const raw of ["null", "[]", "\"ses-authority\"", "7"]) {
    fs.writeFileSync(resolved.path, raw, "utf8");
    assert.equal(
      authority.authorize({ toolName: "mark", input: { action: "brainstormed" }, sessionId: SESSION, toolCallId: "c1" }).reason,
      "[marker-authority] classified runtime identity required",
    );
  }
});

test("replay do mesmo toolCallId é rejeitado depois do consumo", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  const first = call(authority, { action: "brainstormed" });
  assert.equal(first.result.ok, true);
  const replay = authority.execute({ toolCallId: "call-authority", params: first.input, sessionId: SESSION });
  assert.equal(reasonOf(replay), "marker authorization missing, cloned, replayed, or binding-mismatched");
  assert.equal(authority.pendingCount(), 0);
});

test("clone dos args, sessionId divergente e ação trocada falham o binding", () => {
  const root = makeRoot();
  seedGateState(root);

  const cloneAuthority = makeAuthority(root).authority;
  const input = { action: "brainstormed" };
  cloneAuthority.authorize({ toolName: "mark", input, sessionId: SESSION, toolCallId: "c1" });
  const cloned = cloneAuthority.execute({ toolCallId: "c1", params: { ...input }, sessionId: SESSION });
  assert.equal(cloned.ok, true, "um clone com o mesmo toolCallId ainda é o mesmo call do host");

  const sessionAuthority = makeAuthority(root).authority;
  const input2 = { action: "brainstormed" };
  sessionAuthority.authorize({ toolName: "mark", input: input2, sessionId: SESSION, toolCallId: "c2" });
  assert.equal(
    reasonOf(sessionAuthority.execute({ toolCallId: "c2", params: input2, sessionId: "ses-other" })),
    "marker authorization missing, cloned, replayed, or binding-mismatched",
  );

  const actionAuthority = makeAuthority(root).authority;
  const input3 = { action: "brainstormed" };
  actionAuthority.authorize({ toolName: "mark", input: input3, sessionId: SESSION, toolCallId: "c3" });
  input3.action = "demo-done";
  assert.equal(
    reasonOf(actionAuthority.execute({ toolCallId: "c3", params: input3, sessionId: SESSION })),
    "marker authorization missing, cloned, replayed, or binding-mismatched",
  );

  const crossAuthority = makeAuthority(root).authority;
  const authorized = { action: "brainstormed" };
  crossAuthority.authorize({ toolName: "mark", input: authorized, sessionId: SESSION, toolCallId: "c4" });
  crossAuthority.authorize({ toolName: "mark", input: { action: "demo-done" }, sessionId: SESSION, toolCallId: "c5" });
  assert.equal(
    reasonOf(crossAuthority.execute({ toolCallId: "c5", params: authorized, sessionId: SESSION })),
    "marker authorization missing, cloned, replayed, or binding-mismatched",
  );
});

// ---------------------------------------------------------------- mutation preconditions

test("brainstormed persiste e adversary_fired exige brainstormed antes", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);

  const denied = call(authority, { action: "adversary_fired" }, { toolCallId: "c1" });
  assert.equal(reasonOf(denied.result), "adversary_fired requires brainstormed first");
  assert.equal(readGateState(root).adversary_fired, undefined);

  assert.equal(call(authority, { action: "brainstormed" }, { toolCallId: "c2" }).result.ok, true);
  assert.equal(readGateState(root).brainstormed, true);

  assert.equal(call(authority, { action: "adversary_fired" }, { toolCallId: "c3" }).result.ok, true);
  assert.equal(readGateState(root).adversary_fired, true);
});

test("final-review e demo-done são booleanos de feature sem task_id", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  assert.equal(call(authority, { action: "final-review" }, { toolCallId: "c1" }).result.ok, true);
  assert.equal(call(authority, { action: "demo-done" }, { toolCallId: "c2" }).result.ok, true);
  const state = readGateState(root);
  assert.equal(state.final_review_done, true);
  assert.equal(state.demo_done, true);
});

test("task_id inseguro é rejeitado com a mensagem da ação", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  for (const [index, action] of ["fidelity", "regate-pending", "hand-finished", "regate-passed", "capture-verified"].entries()) {
    const denied = call(authority, { action, task_id: "../escape" }, { toolCallId: `c${index}` });
    assert.equal(reasonOf(denied.result), `${action} requires a safe task_id`);
  }
  assert.deepEqual(Object.keys(readGateState(root)).sort(), ["feature_id", "session_id"]);
});

test("fidelity e regate-pending gravam as entradas canônicas", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  assert.equal(call(authority, { action: "fidelity", task_id: TASK }, { toolCallId: "c1" }).result.ok, true);
  assert.equal(call(authority, { action: "regate-pending", task_id: TASK }, { toolCallId: "c2" }).result.ok, true);
  const state = readGateState(root);
  assert.deepEqual(state.fidelity_pass, [`${FEATURE}/${TASK}@${SHA}`]);
  assert.deepEqual(state.regate_pending, [`${FEATURE}/${TASK}`]);
});

test("regate-passed exige regate_pending e um SHA resolvido", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  const denied = call(authority, { action: "regate-passed", task_id: TASK }, { toolCallId: "c1" });
  assert.equal(reasonOf(denied.result), "regate_pending does not contain feature/task");

  const noSha = makeAuthority(root, { resolveHeadSha: () => null }).authority;
  const deniedSha = call(noSha, { action: "regate-passed", task_id: TASK }, { toolCallId: "c2" });
  assert.equal(reasonOf(deniedSha.result), "regate-passed requires a resolved commit SHA");

  assert.equal(call(authority, { action: "regate-pending", task_id: TASK }, { toolCallId: "c3" }).result.ok, true);
  assert.equal(call(authority, { action: "regate-passed", task_id: TASK }, { toolCallId: "c4" }).result.ok, true);
  assert.deepEqual(readGateState(root).regate_passed, [`${FEATURE}/${TASK}@${SHA}`]);
});

test("hand-finished exige um hand-record legível, capture-eligible e do produtor exato", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);

  assert.equal(
    reasonOf(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "c1" }).result),
    "hand-record missing or unreadable",
  );

  seedHandRecord(root, { outcome: "BLOCKED" });
  assert.equal(
    reasonOf(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "c2" }).result),
    "hand-record is not capture-eligible",
  );

  seedHandRecord(root, { producerCallId: "unknown-call" });
  assert.equal(
    reasonOf(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "c3" }).result),
    "exact producer dispatch record required",
  );

  seedHandRecord(root, { agent: "sniper" });
  assert.equal(
    reasonOf(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "c4" }).result),
    "producer dispatch identity mismatch",
  );

  seedHandRecord(root);
  assert.equal(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "c5" }).result.ok, true);
  assert.deepEqual(readGateState(root).hand_finished, [`${FEATURE}/${TASK}`]);
});

test("sem a peça state-records injetada, hand-finished falha fechado", () => {
  const root = makeRoot();
  seedGateState(root);
  seedHandRecord(root);
  const { authority } = makeAuthority(root, { readDispatchRecord: undefined, removeDispatchRecord: undefined });
  assert.equal(
    reasonOf(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "c1" }).result),
    "exact producer dispatch record required",
  );
});

test("capture-verified exige hand_finished, record sem violações, SHA e linhagem", () => {
  const root = makeRoot();
  seedGateState(root);
  seedHandRecord(root);
  const { authority } = makeAuthority(root);

  assert.equal(
    reasonOf(call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c1" }).result),
    "hand_finished does not contain feature/task",
  );

  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });

  seedHandRecord(root, { scopeViolations: ["src/other.ts"] });
  assert.equal(
    reasonOf(call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c2" }).result),
    "hand-record contains scope or frozen violations",
  );

  seedHandRecord(root, { frozenViolations: ["tests/frozen.test.mjs"] });
  assert.equal(
    reasonOf(call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c3" }).result),
    "hand-record contains scope or frozen violations",
  );

  seedHandRecord(root, { freezeCommitSha: "" });
  assert.equal(
    reasonOf(call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c4" }).result),
    "capture-verified requires a resolved commit SHA",
  );

  seedHandRecord(root);
  const stranger = makeAuthority(root, { isAncestorSha: () => false }).authority;
  assert.equal(
    reasonOf(call(stranger, { action: "capture-verified", task_id: TASK }, { toolCallId: "c5" }).result),
    "capture-verified requires the matching record SHA to be ancestral to HEAD",
  );

  seedHandRecord(root, { outcome: "NEEDS_CONTEXT" });
  assert.equal(
    reasonOf(call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c6" }).result),
    "hand-record is not capture-eligible",
  );
});

test("capture-verified ignora args.sha e carimba o freeze SHA do próprio record", () => {
  const root = makeRoot();
  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root);
  const seen = [];
  const { authority } = makeAuthority(root, {
    isAncestorSha: (_root, sha) => { seen.push(sha); return true; },
  });
  const result = call(
    authority,
    { action: "capture-verified", task_id: TASK, sha: "f".repeat(40) },
    { toolCallId: "c1" },
  ).result;
  assert.equal(result.ok, true, result.output);
  assert.deepEqual(readGateState(root).capture_verified, [`${FEATURE}/${TASK}@${SHA}`]);
  assert.deepEqual(seen, [SHA], "a linhagem é aferida contra o SHA do record, nunca contra args.sha");
});

test("hand-finished e capture-verified recusam um record de identidade estrangeira no caminho certo", () => {
  const root = makeRoot();
  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  const { authority, removals } = makeAuthority(root);

  for (const [index, foreign] of [{ sessionId: "ses-other" }, { featureId: "feature-other" }, { taskId: "task-other" }].entries()) {
    seedHandRecord(root, foreign);
    assert.equal(
      reasonOf(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: `h${index}` }).result),
      "hand-record feature/task/session identity mismatch",
    );
    assert.equal(
      reasonOf(call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: `v${index}` }).result),
      "hand-record feature/task/session identity mismatch",
    );
  }
  assert.equal(readGateState(root).capture_verified, undefined);
  assert.equal(readHandRecord(root).capturedVerifiedAt, undefined);
  assert.deepEqual(removals, []);
});

test("capture-verified é da sessão PAI: a sessão filha é negada antes de qualquer mutação", () => {
  const root = makeRoot();
  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root);
  const { authority, removals } = makeAuthority(root);
  const denied = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c1", isChild: true });
  assert.equal(reasonOf(denied.result), "capture-verified is restricted to the parent build agent");
  assert.equal(readGateState(root).capture_verified, undefined);
  assert.equal(readHandRecord(root).capturedVerifiedAt, undefined);
  assert.deepEqual(removals, []);
});

test("capture-verified feliz carimba capturedVerifiedAt e remove o dispatch-record do produtor", () => {
  const root = makeRoot();
  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root);
  const { authority, removals } = makeAuthority(root);
  const result = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c1" }).result;
  assert.equal(result.ok, true);
  assert.deepEqual(readGateState(root).capture_verified, [`${FEATURE}/${TASK}@${SHA}`]);
  assert.equal(readHandRecord(root).capturedVerifiedAt, "2026-01-01T00:00:00.000Z");
  assert.deepEqual(removals, [{ sessionId: SESSION, callId: PRODUCER_CALL }]);
  assert.deepEqual(JSON.parse(result.output), {
    ok: true,
    action: "capture-verified",
    session_id: SESSION,
    feature_id: FEATURE,
  });
});

test("replay do capture-verified é decidido pelo record já carimbado, não pelo payload", () => {
  const root = makeRoot();
  seedGateState(root, {
    hand_finished: [`${FEATURE}/${TASK}`],
    capture_verified: [`${FEATURE}/${TASK}@${SHA}`],
  });
  seedHandRecord(root, { capturedVerifiedAt: "2025-12-31T00:00:00.000Z" });
  const { authority, removals } = makeAuthority(root);
  const result = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c1" }).result;
  assert.equal(result.ok, true);
  assert.equal(readHandRecord(root).capturedVerifiedAt, "2025-12-31T00:00:00.000Z", "o carimbo original é preservado");
  assert.deepEqual(removals, [{ sessionId: SESSION, callId: PRODUCER_CALL }]);
});

test("a identidade do gate-state trocada entre hook e tool nega a mutação", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  const input = { action: "brainstormed" };
  assert.deepEqual(authority.authorize({ toolName: "mark", input, sessionId: SESSION, toolCallId: "c1" }), { ok: true });
  seedGateState(root, { feature_id: "feature-swapped" });
  const result = authority.execute({ toolCallId: "c1", params: input, sessionId: SESSION });
  assert.equal(reasonOf(result), "gate-state identity changed before marker mutation");
  assert.equal(readGateState(root).brainstormed, undefined);
});

// ---------------------------------------------------------------- git defaults ao vivo

test("com git real, capture-verified aceita o SHA ancestral do record e recusa um SHA desconhecido", () => {
  const root = makeRoot();
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "harness"], { cwd: root });
  fs.writeFileSync(path.join(root, "seed.txt"), "seed\n", "utf8");
  execFileSync("git", ["add", "seed.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "seed"], { cwd: root });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root, { freezeCommitSha: head });
  // Sem resolveHeadSha/isAncestorSha injetados: usa os defaults reais de host-hand-capture.
  const { authority, removals } = makeAuthority(root, { resolveHeadSha: undefined, isAncestorSha: undefined });
  const ok = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c1" }).result;
  assert.equal(ok.ok, true, ok.output);
  assert.deepEqual(readGateState(root).capture_verified, [`${FEATURE}/${TASK}@${head}`]);
  assert.equal(typeof readHandRecord(root).capturedVerifiedAt, "string");
  assert.deepEqual(removals, [{ sessionId: SESSION, callId: PRODUCER_CALL }]);

  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root, { freezeCommitSha: SHA });
  const denied = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c2" }).result;
  assert.equal(
    reasonOf(denied),
    "capture-verified requires the matching record SHA to be ancestral to HEAD",
  );
});

// ------------------------------------------- fiação real com core/pi/lib/pi-state-records.mjs

test("com dispatch-records reais da lane Pi, hand-finished valida o produtor e capture-verified o remove", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "unit.ts"), "export const unit = 1;\n", "utf8");
  const scope = normalizeProjectPath(root, "src");
  assert.equal(scope.ok, true);

  const recordPath = piDispatchRecordPath(root, SESSION, PRODUCER_CALL);
  assert.equal(recordPath.ok, true);
  fs.mkdirSync(path.dirname(recordPath.path), { recursive: true });
  fs.writeFileSync(
    recordPath.path,
    JSON.stringify({
      parent_session_id: SESSION,
      dispatch_call_id: PRODUCER_CALL,
      child_session_id: null,
      feature_id: FEATURE,
      task_id: TASK,
      role: "executor",
      plan_hash: "a".repeat(64),
      claimed_at: new Date().toISOString(),
      scope_paths: [scope.path],
      allowed_writes: [],
    }, null, 2),
    "utf8",
  );
  assert.equal(readPiDispatchRecord(root, { parentSessionId: SESSION, callId: PRODUCER_CALL }).ok, true);

  seedGateState(root);
  seedHandRecord(root);
  const authority = createPiMarkerAuthority({
    projectRoot: root,
    readDispatchRecord: readPiDispatchRecord,
    removeDispatchRecord: removePiDispatchRecord,
    resolveHeadSha: () => SHA,
    isAncestorSha: () => true,
    now: () => "2026-01-01T00:00:00.000Z",
  });

  const finished = call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "c1" }).result;
  assert.equal(finished.ok, true, finished.output);
  assert.equal(fs.existsSync(recordPath.path), true, "hand-finished não remove o dispatch-record");

  const verified = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c2" }).result;
  assert.equal(verified.ok, true, verified.output);
  assert.equal(fs.existsSync(recordPath.path), false, "capture-verified remove o dispatch-record do produtor");
  assert.deepEqual(readGateState(root).capture_verified, [`${FEATURE}/${TASK}@${SHA}`]);
  assert.equal(readHandRecord(root).capturedVerifiedAt, "2026-01-01T00:00:00.000Z");
});
