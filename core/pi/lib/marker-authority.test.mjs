/**
 * @description Testes da autoridade de marcadores da lane Pi. Espelham
 * core/opencode/plugin/marker-authority.test.mjs: cada pré-condição de mutação, o par
 * hook+tool (execute direto, clone, replay), a restrição de sessão PAI no capture-verified
 * e o caminho feliz (carimbo capturedVerifiedAt + remoção do dispatch-record do produtor).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPiMarkerAuthority, MARKER_ACTIONS, markerResponse } from "./marker-authority.mjs";
import { piExecutionPlanPath, piGateStatePath, piHandRecordPath, piSpecPath } from "./pi-paths.mjs";
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
const REVIEW_INPUT_DIGEST = "a".repeat(64);
const EMPTY_REPORT = { issues: [] };
const EMPTY_REPORT_DIGEST = crypto.createHash("sha256").update(JSON.stringify(EMPTY_REPORT)).digest("hex");

function acceptedReviewFields(inputDigest = REVIEW_INPUT_DIGEST) {
  return {
    accepted: true,
    input_digest: inputDigest,
    report_digest: EMPTY_REPORT_DIGEST,
    report: EMPTY_REPORT,
  };
}

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

function seedDraftSpec(root) {
  const spec = piSpecPath({ projectRoot: root, featureId: FEATURE });
  const content = "# Draft\n";
  const sha = crypto.createHash("sha256").update(content).digest("hex");
  fs.mkdirSync(path.dirname(spec.path), { recursive: true });
  fs.writeFileSync(spec.path, content);
  const state = readGateState(root);
  fs.writeFileSync(piGateStatePath({ projectRoot: root, sessionId: SESSION }).path, JSON.stringify({ ...state, mode: "FULL", spec_status: "draft", spec_sha256: sha }));
  return sha;
}

function seedApprovedSpec(root) {
  const sha = seedDraftSpec(root);
  const state = readGateState(root);
  fs.writeFileSync(piGateStatePath({ projectRoot: root, sessionId: SESSION }).path, JSON.stringify({
    ...state, adversary_fired: true, adversary_spec_sha256: sha,
    spec_status: "adversary-reviewed", reviewed_spec_sha256: sha,
  }));
  return sha;
}

/** Evidência gravada pelo host quando a filha adversária termina com sucesso. */
function seedSuccessfulAdversary(root) {
  const state = readGateState(root);
  state.adversary_completion_evidence = {
    written_by: "host-subagent-completion",
    role: "harness-adversary",
    parent_session_id: SESSION,
    feature_id: FEATURE,
    dispatch_call_id: "adversary-call",
    child_session_id: "ses-adversary-child",
    agent_id: "agent-adversary",
    status: "completed",
    spec_sha256: state.spec_sha256,
  };
  const resolved = piGateStatePath({ projectRoot: root, sessionId: SESSION });
  fs.writeFileSync(resolved.path, JSON.stringify(state, null, 2), "utf8");
}

/** @description Plano mínimo já congelado: este teste da autoridade só precisa provar a cobertura de tarefas. */
function seedPlan(root, tasks = [{ id: TASK }]) {
  const resolved = piExecutionPlanPath({ projectRoot: root, featureId: FEATURE });
  assert.equal(resolved.ok, true);
  fs.mkdirSync(path.dirname(resolved.path), { recursive: true });
  fs.writeFileSync(resolved.path, JSON.stringify({ feature_id: FEATURE, tasks }, null, 2), "utf8");
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
  const dispatchRole = overrides.dispatchRole ?? "executor";
  const { dispatchRole: _ignoredDispatchRole, ...authorityOverrides } = overrides;
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
              role: dispatchRole,
            },
          }
        : { ok: false, reason: "dispatch record absent" },
    removeDispatchRecord: (_root, ids) => {
      removals.push(ids);
      return { ok: true, removed: true };
    },
    resolveHeadSha: () => SHA,
    isAncestorSha: () => true,
    captureReviewInputFn: () => ({ ok: true, snapshot: { input_digest: REVIEW_INPUT_DIGEST } }),
    now: () => "2026-01-01T00:00:00.000Z",
    ...authorityOverrides,
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
  seedApprovedSpec(root);
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
  seedApprovedSpec(root);

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

test("adversary_fired exige a draft corrente e evidência host-owned da filha", () => {
  const root = makeRoot();
  seedGateState(root);
  seedDraftSpec(root);
  const { authority } = makeAuthority(root);

  const denied = call(authority, { action: "adversary_fired" }, { toolCallId: "c1" });
  assert.equal(reasonOf(denied.result), "adversary_fired requires host-owned evidence for the current spec hash");
  assert.equal(readGateState(root).adversary_fired, undefined);

  assert.equal(
    reasonOf(call(authority, { action: "adversary_fired" }, { toolCallId: "c2" }).result),
    "adversary_fired requires host-owned evidence for the current spec hash",
  );

  seedSuccessfulAdversary(root);
  assert.equal(call(authority, { action: "adversary_fired" }, { toolCallId: "c3" }).result.ok, true);
  assert.equal(readGateState(root).adversary_fired, true);
});

test("adversary_fired rejeita evidência de filha interrompida, mesmo com todos os outros campos válidos", () => {
  const root = makeRoot();
  seedGateState(root);
  seedDraftSpec(root);
  seedSuccessfulAdversary(root);
  const state = readGateState(root);
  state.adversary_completion_evidence.status = "steered";
  const resolved = piGateStatePath({ projectRoot: root, sessionId: SESSION });
  fs.writeFileSync(resolved.path, JSON.stringify(state, null, 2), "utf8");

  const { authority } = makeAuthority(root);
  const result = call(authority, { action: "adversary_fired" }, { toolCallId: "interrupted" }).result;
  assert.equal(reasonOf(result), "adversary_fired requires successful host-owned adversary completion evidence");
  assert.equal(readGateState(root).adversary_fired, undefined);
});

test("final-review exige capturas verificadas e recibos host-owned atuais dos dois olhos finais", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);

  assert.equal(
    reasonOf(call(authority, { action: "final-review" }, { toolCallId: "c1" }).result),
    "final-review requires a readable canonical execution plan",
  );

  seedPlan(root);
  seedHandRecord(root, { capturedVerifiedAt: "2025-12-31T00:00:00.000Z" });
  seedGateState(root, {
    hand_finished: [`${FEATURE}/${TASK}`],
    capture_verified: [`${FEATURE}/${TASK}@${SHA}`],
  });
  assert.equal(
    reasonOf(call(authority, { action: "final-review" }, { toolCallId: "c2" }).result),
    "final-review requires current host-owned final adversary evidence",
  );
  const stateWithAdversary = readGateState(root);
  stateWithAdversary.final_review_evidence = {
    adversary: {
      written_by: "host-subagent-completion", role: "harness-adversary", parent_session_id: SESSION,
      feature_id: FEATURE, dispatch_call_id: "final-adversary", child_session_id: "child-adversary",
      agent_id: "agent-adversary", status: "completed", reviewed_head_sha: SHA, ...acceptedReviewFields(),
    },
  };
  fs.writeFileSync(piGateStatePath({ projectRoot: root, sessionId: SESSION }).path, JSON.stringify(stateWithAdversary));
  assert.equal(
    reasonOf(call(authority, { action: "final-review" }, { toolCallId: "c3" }).result),
    "final-review requires current host-owned final compliance evidence",
  );
  const stateWithBothEyes = readGateState(root);
  stateWithBothEyes.final_review_evidence.compliance = {
    written_by: "host-subagent-completion", role: "harness-compliance", parent_session_id: SESSION,
    feature_id: FEATURE, dispatch_call_id: "final-compliance", child_session_id: "child-compliance",
    agent_id: "agent-compliance", status: "completed", reviewed_head_sha: SHA, ...acceptedReviewFields(),
  };
  fs.writeFileSync(piGateStatePath({ projectRoot: root, sessionId: SESSION }).path, JSON.stringify(stateWithBothEyes));
  assert.equal(call(authority, { action: "final-review" }, { toolCallId: "c4" }).result.ok, true);
  assert.equal(call(authority, { action: "demo-done" }, { toolCallId: "c5" }).result.ok, true);
  const state = readGateState(root);
  assert.equal(state.final_review_done, true);
  assert.equal(state.demo_done, true);
});

test("final-review rejeita recibos que só dizem completed no HEAD sem relatório aceito e digests", () => {
  const root = makeRoot();
  seedGateState(root);
  seedPlan(root);
  seedHandRecord(root, { capturedVerifiedAt: "2025-12-31T00:00:00.000Z" });
  seedGateState(root, {
    hand_finished: [`${FEATURE}/${TASK}`],
    capture_verified: [`${FEATURE}/${TASK}@${SHA}`],
    final_review_evidence: {
      adversary: {
        written_by: "host-subagent-completion", role: "harness-adversary", parent_session_id: SESSION,
        feature_id: FEATURE, dispatch_call_id: "legacy-adversary", child_session_id: "legacy-child-adversary",
        agent_id: "legacy-agent-adversary", status: "completed", reviewed_head_sha: SHA,
      },
      compliance: {
        written_by: "host-subagent-completion", role: "harness-compliance", parent_session_id: SESSION,
        feature_id: FEATURE, dispatch_call_id: "legacy-compliance", child_session_id: "legacy-child-compliance",
        agent_id: "legacy-agent-compliance", status: "completed", reviewed_head_sha: SHA,
      },
    },
  });
  const result = call(makeAuthority(root).authority, { action: "final-review" }, { toolCallId: "legacy-final" }).result;
  assert.equal(reasonOf(result), "final-review requires current host-owned final adversary evidence");
  assert.equal(readGateState(root).final_review_done, undefined);
});

test("final-review exige security saudável quando o plano canônico a torna obrigatória", () => {
  const root = makeRoot();
  seedPlan(root);
  const planPath = piExecutionPlanPath({ projectRoot: root, featureId: FEATURE }).path;
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  fs.writeFileSync(planPath, JSON.stringify({ ...plan, final_review: { adversary: true, compliance: true, security: true } }));
  seedHandRecord(root, { capturedVerifiedAt: "2025-12-31T00:00:00.000Z" });
  const final_review_evidence = Object.fromEntries(["adversary", "compliance"].map((name) => [name, {
    written_by: "host-subagent-completion", role: `harness-${name}`, parent_session_id: SESSION,
    feature_id: FEATURE, dispatch_call_id: `call-${name}`, child_session_id: `child-${name}`,
    agent_id: `agent-${name}`, status: "completed", reviewed_head_sha: SHA, ...acceptedReviewFields(),
  }]));
  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`], capture_verified: [`${FEATURE}/${TASK}@${SHA}`], final_review_evidence });
  const { authority } = makeAuthority(root);
  const missing = call(authority, { action: "final-review" }, { toolCallId: "missing-security" }).result;
  assert.equal(missing.ok, false, "security required by the canonical plan cannot be omitted");
  assert.match(reasonOf(missing), /security/i);
  assert.equal(readGateState(root).final_review_done, undefined);
  const state = readGateState(root);
  state.final_review_evidence.security = { ...final_review_evidence.adversary,
    role: "harness-security", dispatch_call_id: "call-security", child_session_id: "child-security", agent_id: "agent-security" };
  fs.writeFileSync(piGateStatePath({ projectRoot: root, sessionId: SESSION }).path, JSON.stringify(state));
  assert.equal(call(authority, { action: "final-review" }, { toolCallId: "healthy-security" }).result.ok, true);
});

test("final-review rejeita recibos aceitos quando o snapshot atual mudou sem trocar o HEAD", () => {
  const root = makeRoot();
  seedGateState(root);
  seedPlan(root);
  seedHandRecord(root, { capturedVerifiedAt: "2025-12-31T00:00:00.000Z" });
  const receipt = (role, suffix) => ({
    written_by: "host-subagent-completion", role, parent_session_id: SESSION, feature_id: FEATURE,
    dispatch_call_id: `stale-${suffix}`, child_session_id: `stale-child-${suffix}`,
    agent_id: `stale-agent-${suffix}`, status: "completed", reviewed_head_sha: SHA,
    ...acceptedReviewFields(REVIEW_INPUT_DIGEST),
  });
  seedGateState(root, {
    hand_finished: [`${FEATURE}/${TASK}`],
    capture_verified: [`${FEATURE}/${TASK}@${SHA}`],
    final_review_evidence: {
      adversary: receipt("harness-adversary", "adversary"),
      compliance: receipt("harness-compliance", "compliance"),
    },
  });
  const authority = makeAuthority(root, {
    captureReviewInputFn: () => ({ ok: true, snapshot: { input_digest: "b".repeat(64) } }),
  }).authority;
  const result = call(authority, { action: "final-review" }, { toolCallId: "stale-final" }).result;
  assert.equal(reasonOf(result), "final-review requires current host-owned final adversary evidence");
  assert.equal(readGateState(root).final_review_done, undefined);
});

test("final-review aceita recibos integrados de cada tarefa sem reescrever a sessão filha", () => {
  const root = makeRoot();
  seedPlan(root, [{ id: TASK }, { id: "task-two" }]);
  const receipt = (role, suffix) => ({
    written_by: "host-subagent-completion", role, parent_session_id: SESSION, feature_id: FEATURE,
    dispatch_call_id: `integrated-${suffix}`, child_session_id: `review-child-${suffix}`,
    agent_id: `review-agent-${suffix}`, status: "completed", reviewed_head_sha: SHA,
    ...acceptedReviewFields(),
  });
  seedGateState(root, { final_review_evidence: {
    adversary: receipt("harness-adversary", "adversary"),
    compliance: receipt("harness-compliance", "compliance"),
  } });
  const seen = [];
  const authority = makeAuthority(root, {
    readIntegratedTaskEvidenceFn: (input) => {
      seen.push(input);
      return { ok: true, result: { session_id: `child-${input.taskId}` } };
    },
  }).authority;
  const result = call(authority, { action: "final-review" }, { toolCallId: "integrated-final" }).result;
  assert.equal(result.ok, true, reasonOf(result));
  assert.deepEqual(seen.map((item) => item.taskId), [TASK, "task-two"]);
  assert.ok(seen.every((item) => item.sessionId === SESSION && item.headSha === SHA));
});

test("final-review global task-pipeline não usa captura legada durante barreira de correção", () => {
  const root = makeRoot();
  seedPlan(root);
  seedHandRecord(root, { capturedVerifiedAt: "2025-12-31T00:00:00.000Z" });
  const receipt = (role, suffix) => ({
    written_by: "host-subagent-completion", role, parent_session_id: SESSION, feature_id: FEATURE,
    dispatch_call_id: `barrier-${suffix}`, child_session_id: `barrier-child-${suffix}`,
    agent_id: `barrier-agent-${suffix}`, status: "completed", reviewed_head_sha: SHA,
    ...acceptedReviewFields(),
  });
  seedGateState(root, {
    task_pipeline_version: 1,
    hand_finished: [`${FEATURE}/${TASK}`],
    capture_verified: [`${FEATURE}/${TASK}@${SHA}`],
    final_review_evidence: {
      adversary: receipt("harness-adversary", "adversary"),
      compliance: receipt("harness-compliance", "compliance"),
    },
  });
  const authority = makeAuthority(root, {
    readIntegratedTaskEvidenceFn: () => ({ ok: false, reason: "correction barrier active" }),
  }).authority;
  const result = call(authority, { action: "final-review" }, { toolCallId: "barrier-final" }).result;
  assert.equal(result.ok, false);
  assert.match(reasonOf(result), /missing current integrated task evidence/i);
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

test("fidelity exige o hand-record exato do test-author; regate-pending grava a entrada canônica", () => {
  const root = makeRoot();
  seedGateState(root);
  const absent = makeAuthority(root).authority;
  assert.equal(
    reasonOf(call(absent, { action: "fidelity", task_id: TASK }, { toolCallId: "c1" }).result),
    "fidelity requires a capture-eligible test-author hand-record",
  );

  seedHandRecord(root, { agent: "test-author" });
  const { authority } = makeAuthority(root, { dispatchRole: "test-author" });
  assert.equal(call(authority, { action: "fidelity", task_id: TASK }, { toolCallId: "c2" }).result.ok, true);
  assert.equal(call(authority, { action: "regate-pending", task_id: TASK }, { toolCallId: "c3" }).result.ok, true);
  const state = readGateState(root);
  assert.deepEqual(state.fidelity_pass, [`${FEATURE}/${TASK}@${SHA}`]);
  assert.deepEqual(state.regate_pending, [`${FEATURE}/${TASK}`]);
});

test("regate-passed exige recibo host-owned do adversary para a tarefa e SHA atual", () => {
  const root = makeRoot();
  seedGateState(root);
  const { authority } = makeAuthority(root);
  const denied = call(authority, { action: "regate-passed", task_id: TASK }, { toolCallId: "c1" });
  assert.equal(reasonOf(denied.result), "regate_pending does not contain feature/task");

  const noSha = makeAuthority(root, { resolveHeadSha: () => null }).authority;
  const deniedSha = call(noSha, { action: "regate-passed", task_id: TASK }, { toolCallId: "c2" });
  assert.equal(reasonOf(deniedSha.result), "regate-passed requires a resolved commit SHA");

  assert.equal(call(authority, { action: "regate-pending", task_id: TASK }, { toolCallId: "c3" }).result.ok, true);
  assert.equal(
    reasonOf(call(authority, { action: "regate-passed", task_id: TASK }, { toolCallId: "c4" }).result),
    "regate-passed requires current host-owned task adversary evidence",
  );
  const state = readGateState(root);
  state.task_adversary_evidence = {
    [`${FEATURE}/${TASK}`]: {
      written_by: "host-subagent-completion",
      role: "harness-adversary",
      parent_session_id: SESSION,
      feature_id: FEATURE,
      task_id: TASK,
      dispatch_call_id: "adversary-task-call",
      child_session_id: "ses-adversary-task-child",
      agent_id: "agent-adversary-task",
      status: "completed",
      reviewed_head_sha: SHA,
      ...acceptedReviewFields(),
    },
  };
  seedGateState(root, state);
  assert.equal(call(authority, { action: "regate-passed", task_id: TASK }, { toolCallId: "c5" }).result.ok, true);
  assert.deepEqual(readGateState(root).regate_passed, [`${FEATURE}/${TASK}@${SHA}`]);
});

test("regate-passed rejeita recibo completed no HEAD sem relatório aceito e digests", () => {
  const root = makeRoot();
  seedGateState(root, {
    regate_pending: [`${FEATURE}/${TASK}`],
    task_adversary_evidence: {
      [`${FEATURE}/${TASK}`]: {
        written_by: "host-subagent-completion", role: "harness-adversary", parent_session_id: SESSION,
        feature_id: FEATURE, task_id: TASK, dispatch_call_id: "legacy-task-review",
        child_session_id: "legacy-task-child", agent_id: "legacy-task-agent", status: "completed",
        reviewed_head_sha: SHA,
      },
    },
  });
  const result = call(makeAuthority(root).authority, { action: "regate-passed", task_id: TASK }, { toolCallId: "legacy-regate" }).result;
  assert.equal(reasonOf(result), "regate-passed requires current host-owned task adversary evidence");
  assert.equal(readGateState(root).regate_passed, undefined);
});

test("regate-passed rejeita recibo aceito quando o snapshot atual da task mudou no mesmo HEAD", () => {
  const root = makeRoot();
  seedGateState(root, {
    regate_pending: [`${FEATURE}/${TASK}`],
    task_adversary_evidence: {
      [`${FEATURE}/${TASK}`]: {
        written_by: "host-subagent-completion", role: "harness-adversary", parent_session_id: SESSION,
        feature_id: FEATURE, task_id: TASK, dispatch_call_id: "stale-task-review",
        child_session_id: "stale-task-child", agent_id: "stale-task-agent", status: "completed",
        reviewed_head_sha: SHA, ...acceptedReviewFields(REVIEW_INPUT_DIGEST),
      },
    },
  });
  const authority = makeAuthority(root, {
    captureReviewInputFn: () => ({ ok: true, snapshot: { input_digest: "b".repeat(64) } }),
  }).authority;
  const result = call(authority, { action: "regate-passed", task_id: TASK }, { toolCallId: "stale-regate" }).result;
  assert.equal(reasonOf(result), "regate-passed requires current host-owned task adversary evidence");
  assert.equal(readGateState(root).regate_passed, undefined);
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

test("marcadores de workflow são da sessão PAI: a sessão filha é negada antes de qualquer mutação", () => {
  const root = makeRoot();
  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root);
  const { authority, removals } = makeAuthority(root);
  const denied = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "c1", isChild: true });
  assert.equal(reasonOf(denied.result), "privileged workflow markers are restricted to the parent orchestrator");
  assert.equal(readGateState(root).capture_verified, undefined);
  assert.equal(readHandRecord(root).capturedVerifiedAt, undefined);
  assert.deepEqual(removals, []);
});

test("filha não pode forjar a conclusão de brainstorming", () => {
  const root = makeRoot();
  seedGateState(root);
  seedApprovedSpec(root);
  const { authority } = makeAuthority(root);

  const denied = call(authority, { action: "brainstormed" }, { toolCallId: "child-brainstorm", isChild: true });

  assert.equal(reasonOf(denied.result), "privileged workflow markers are restricted to the parent orchestrator");
  assert.equal(readGateState(root).brainstormed, undefined);
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

test("capture-verified observa HEAD real e limpeza de produto sem persistir um novo recibo", () => {
  const root = makeRoot();
  execFileSync("git", ["init", "-q", "-b", "feat/capture-origin"], { cwd: root });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "harness"], { cwd: root });
  fs.writeFileSync(path.join(root, "product.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "--", "product.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  const freezeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root, { freezeCommitSha: freezeSha });
  fs.writeFileSync(path.join(root, "implementation.txt"), "product\n", "utf8");
  execFileSync("git", ["add", "--", "implementation.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "implement product"], { cwd: root });
  const productHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const { authority } = makeAuthority(root, { isAncestorSha: () => true });

  const clean = call(authority, {
    action: "capture-verified",
    task_id: TASK,
    sha: "f".repeat(40),
  }, { toolCallId: "origin-clean" }).result;
  assert.deepEqual(clean.metadata.capture_origin, {
    task_id: TASK,
    producer_call_id: PRODUCER_CALL,
    head_sha: productHead,
    worktree_clean: true,
  });
  assert.deepEqual(JSON.parse(clean.output).capture_origin, clean.metadata.capture_origin);

  fs.writeFileSync(path.join(root, "product.txt"), "staged change\n", "utf8");
  execFileSync("git", ["add", "--", "product.txt"], { cwd: root });
  const staged = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "origin-staged" }).result;
  assert.equal(staged.metadata.capture_origin.worktree_clean, false);
  fs.writeFileSync(path.join(root, "product.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "--", "product.txt"], { cwd: root });

  fs.writeFileSync(path.join(root, "untracked-product.txt"), "dirty\n", "utf8");
  const untracked = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "origin-untracked" }).result;
  assert.equal(untracked.metadata.capture_origin.worktree_clean, false);
  execFileSync("git", ["add", "--", "untracked-product.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "commit recovered product"], { cwd: root });
  const recoveredHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const recovered = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "origin-recovered" }).result;
  assert.deepEqual(recovered.metadata.capture_origin, {
    task_id: TASK,
    producer_call_id: PRODUCER_CALL,
    head_sha: recoveredHead,
    worktree_clean: true,
  });

  fs.mkdirSync(path.join(root, ".pi/harness/runtime"), { recursive: true });
  fs.writeFileSync(path.join(root, ".pi/harness/runtime/observation.json"), "{}", "utf8");
  fs.mkdirSync(path.join(root, "node_modules/example"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules/example/cache"), "ephemeral", "utf8");
  const ephemeral = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "origin-ephemeral" }).result;
  assert.equal(ephemeral.metadata.capture_origin.worktree_clean, true);
  assert.equal(ephemeral.metadata.capture_origin.head_sha, recoveredHead);
});

test("capture_origin nunca declara clean quando HEAD muda durante a mutação", () => {
  const root = makeRoot();
  execFileSync("git", ["init", "-q", "-b", "feat/capture-race"], { cwd: root });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "harness"], { cwd: root });
  fs.writeFileSync(path.join(root, "product.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "--", "product.txt"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
  const before = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  seedGateState(root, { hand_finished: [`${FEATURE}/${TASK}`] });
  seedHandRecord(root, { freezeCommitSha: before });
  const { authority } = makeAuthority(root, {
    removeDispatchRecord: () => {
      fs.writeFileSync(path.join(root, "racing-product.txt"), "committed concurrently\n", "utf8");
      execFileSync("git", ["add", "--", "racing-product.txt"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "concurrent product commit"], { cwd: root });
      return { ok: true, removed: true };
    },
  });

  const result = call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "origin-race" }).result;
  assert.equal(result.ok, true, result.output);
  assert.equal(result.metadata.capture_origin.head_sha, before);
  assert.equal(result.metadata.capture_origin.worktree_clean, false);
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

test("commits locais freeze e impl preservam a linhagem real de fidelity e capture", () => {
  const root = makeRoot();
  execFileSync("git", ["init", "-q", "-b", "feat/task-commits"], { cwd: root });
  execFileSync("git", ["config", "user.email", "harness@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "harness"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "fixture\n", "utf8");
  execFileSync("git", ["add", "--", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "chore: seed"], { cwd: root });
  const handSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  seedGateState(root, { task_run: {} });
  seedHandRecord(root, { agent: "test-author", freezeCommitSha: handSha });

  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(path.join(root, "tests", "app.test.mjs"), "// expected-red locked test\n", "utf8");
  execFileSync("git", ["add", "--", "tests/app.test.mjs"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "test(app): freeze locked test for task-one"], { cwd: root });
  const freezeCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  let freezeValidations = 0;
  const { authority } = makeAuthority(root, {
    dispatchRole: "test-author",
    resolveHeadSha: undefined,
    isAncestorSha: undefined,
    validateTaskFidelityFreezeFn: (input) => {
      freezeValidations++;
      assert.deepEqual(input, {
        projectRoot: root,
        sessionId: SESSION,
        taskId: TASK,
        testAuthorSha: handSha,
      });
      return { ok: true, freezeSha: freezeCommit };
    },
  });

  assert.equal(call(authority, { action: "hand-finished", task_id: TASK }, { toolCallId: "real-hf" }).result.ok, true);
  assert.equal(call(authority, { action: "fidelity", task_id: TASK }, { toolCallId: "real-fidelity" }).result.ok, true);
  assert.equal(call(authority, { action: "capture-verified", task_id: TASK }, { toolCallId: "real-capture" }).result.ok, true);
  assert.deepEqual(readGateState(root).fidelity_pass, [`${FEATURE}/${TASK}@${freezeCommit}`]);
  assert.deepEqual(readGateState(root).capture_verified, [`${FEATURE}/${TASK}@${handSha}`]);
  assert.equal(freezeValidations, 1);

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const ready = true;\n", "utf8");
  execFileSync("git", ["add", "--", "src/app.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "feat(app): implement task-one"], { cwd: root });
  const implCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();

  assert.equal(execFileSync("git", ["merge-base", "--is-ancestor", handSha, freezeCommit], { cwd: root }).length, 0);
  assert.equal(execFileSync("git", ["merge-base", "--is-ancestor", freezeCommit, implCommit], { cwd: root }).length, 0);
  assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: root, encoding: "utf8" }), "");
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
