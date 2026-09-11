import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquirePiParentWorktreeLock,
  darwinProcessIdentity,
  linuxProcessIdentity,
  recoverPiParentSession,
} from "./parent-session-recovery.mjs";
import { decidePiDispatchGate } from "./entry-gate.mjs";
import { readPiSpecApproval, writePiSpecDraft } from "./spec-approval.mjs";

const SESSION = "ses-parent-resume";
const FEATURE = "parent-resume";
const MODELS = {
  hand_tiers: { low: "openai-codex/gpt-5.6-luna", medium: "openai-codex/gpt-5.6-terra", high: "openai-codex/gpt-5.6-terra" },
  planner: "openai-codex/gpt-5.6-sol", "plan-reviewer": "openai-codex/gpt-6-astra", compliance: "openai-codex/gpt-5.6-terra",
  adversary: "openai-codex/gpt-5.6-sol", security: "openai-codex/gpt-5.6-sol", shipper: "openai-codex/gpt-5.6-luna", harvester: "openai-codex/gpt-5.6-luna",
};
const LEGACY_MODELS = { ...MODELS, "plan-reviewer": "openai-codex/gpt-5.6-sol" };

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function fixture({ headerCwd, mode = "FULL", statePatch = {}, spec = "# Approved\n" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-parent-resume-")));
  const sessions = path.join(root, ".pi", "harness", "sessions");
  const state = path.join(root, ".pi", "harness", "state", SESSION, "gate-state.json");
  const plan = path.join(root, ".pi", "harness", "plans", FEATURE, "execution-plan.json");
  const specPath = path.join(root, ".pi", "harness", "plans", FEATURE, "spec.md");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.mkdirSync(path.dirname(plan), { recursive: true });
  fs.writeFileSync(specPath, spec);
  fs.writeFileSync(path.join(sessions, `2026-01-01T00-00-00-000Z_${SESSION}.jsonl`), `${JSON.stringify({ type: "session", version: 3, id: SESSION, cwd: headerCwd ?? root })}\n`);
  fs.writeFileSync(state, JSON.stringify({
    session_id: SESSION, feature_id: FEATURE, mode, classified: true,
    brainstormed: true, adversary_fired: true, spec_status: "adversary-reviewed",
    spec_sha256: sha(spec), adversary_spec_sha256: sha(spec), reviewed_spec_sha256: sha(spec),
    ...statePatch,
  }));
  fs.writeFileSync(plan, JSON.stringify({
    feature_id: FEATURE, kind: "full", mode: mode.toLowerCase(), model_strategy: MODELS,
    tasks: ["one", "two"].map((id) => ({
      id: `task-${id}`, severity: "low", complexity: "low", scope_paths: ["src/index.ts"],
      criterion_refs: ["#ac-1"], locked_tests: [], no_tests: true, depends_on: [],
    })),
  }));
  return { root, sessions, state, plan, specPath, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function draftFixture(patch = {}) {
  const f = fixture();
  const state = JSON.parse(fs.readFileSync(f.state, "utf8"));
  for (const key of ["brainstormed", "adversary_fired", "adversary_spec_sha256", "reviewed_spec_sha256"])
    delete state[key];
  Object.assign(state, { spec_status: "draft", triaged: true, task_pipeline_version: 1 }, patch);
  fs.writeFileSync(f.state, JSON.stringify(state));
  fs.unlinkSync(f.plan);
  return f;
}

function completedSpecReview() {
  return {
    written_by: "host-subagent-completion", parent_session_id: SESSION, feature_id: FEATURE,
    role: "harness-adversary", dispatch_call_id: "review-call", child_session_id: "review-child",
    agent_id: "review-agent", status: "completed", spec_sha256: sha("# Approved\n"),
  };
}

test("interrupted draft resumes the exact conversation without approving or unlocking delivery", () => {
  // Real interruption: a native review completed, but its marker/seal was not consumed.
  const f = draftFixture({ adversary_completion_evidence: completedSpecReview() });
  try {
    const before = fs.readFileSync(f.state);
    const result = recoverPiParentSession(f.root, SESSION);
    assert.equal(result.ok, true, result.reason);
    const envelope = JSON.parse(result.context.split("\n")[1]);
    assert.equal(envelope.stage, "draft");
    assert.equal(envelope.spec_approval, "not_verified_by_recovery");
    assert.equal(envelope.canonical_plan_path, undefined);
    assert.equal(readPiSpecApproval({ projectRoot: f.root, sessionId: SESSION }).ok, false);
    for (const subagentType of ["harness-planner", "harness-executor"]) {
      assert.equal(decidePiDispatchGate({ projectRoot: f.root, sessionId: SESSION, subagentType, env: {} }).decision, "deny");
    }
    assert.deepEqual(fs.readFileSync(f.state), before);
    assert.equal(fs.readdirSync(f.sessions).length, 1);
    assert.equal(fs.existsSync(f.plan), false);
  } finally { f.cleanup(); }
});

test("draft can resume between the current adversary marker and the spec seal", () => {
  const f = draftFixture({ adversary_fired: true, adversary_spec_sha256: sha("# Approved\n"),
    adversary_completion_evidence: completedSpecReview() });
  try {
    const before = fs.readFileSync(f.state);
    assert.equal(recoverPiParentSession(f.root, SESSION).ok, true);
    assert.equal(readPiSpecApproval({ projectRoot: f.root, sessionId: SESSION }).ok, false);
    assert.deepEqual(fs.readFileSync(f.state), before);
  } finally { f.cleanup(); }
});

test("partial recovery rejects contradictory classification, draft seals and stale review hashes", () => {
  for (const patch of [
    { classified: false }, { classification_source: "delegated-task" },
    { brainstormed: true }, { brainstormed: "true" }, { reviewed_spec_sha256: sha("# Approved\n") },
    { reviewed_at: "2026-09-07T00:00:00Z" },
    { adversary_fired: true }, { adversary_spec_sha256: "0".repeat(64) },
    { adversary_fired: true, adversary_spec_sha256: sha("# Approved\n") },
    { adversary_fired: true, adversary_spec_sha256: sha("# Approved\n"),
      adversary_completion_evidence: { ...completedSpecReview(), parent_session_id: "another-parent" } },
    { spec_status: "unknown" }, { spec_sha256: "0".repeat(64) },
  ]) {
    const f = draftFixture(patch);
    try { assert.equal(recoverPiParentSession(f.root, SESSION).ok, false, JSON.stringify(patch)); }
    finally { f.cleanup(); }
  }
});

test("sealed spec resumes before a canonical plan exists, without creating or approving it", () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.plan);
    const before = fs.readFileSync(f.state);
    const result = recoverPiParentSession(f.root, SESSION);
    assert.equal(result.ok, true, result.reason);
    const envelope = JSON.parse(result.context.split("\n")[1]);
    assert.equal(envelope.stage, "pre-plan");
    assert.equal(envelope.plan_approval, "not_verified_by_recovery");
    assert.equal(envelope.canonical_plan_sha256, undefined);
    assert.deepEqual(fs.readFileSync(f.state), before);
    assert.equal(fs.existsSync(f.plan), false);
  } finally { f.cleanup(); }
});

test("a missing plan after delivery evidence is not a pre-plan checkpoint", () => {
  for (const patch of [{ plan_review_evidence: null }, { hand_finished: ["parent-resume/task-one"] }, { final_review_done: true }]) {
    const f = fixture({ statePatch: patch });
    try {
      fs.unlinkSync(f.plan);
      assert.equal(recoverPiParentSession(f.root, SESSION).ok, false);
    } finally { f.cleanup(); }
  }
  for (const artifact of ["task-runs/index.json", "../hand-records/parent-resume/ses-parent-resume/task-one.json"]) {
    const f = fixture();
    try {
      fs.unlinkSync(f.plan);
      const file = path.resolve(path.dirname(f.state), artifact);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{}");
      assert.equal(recoverPiParentSession(f.root, SESSION).ok, false);
    } finally { f.cleanup(); }
  }
});

test("empty directories created by observation do not prevent pre-plan recovery", () => {
  const f = fixture();
  try {
    fs.unlinkSync(f.plan);
    for (const artifact of ["task-runs", "../hand-records/parent-resume/ses-parent-resume"])
      fs.mkdirSync(path.resolve(path.dirname(f.state), artifact), { recursive: true });
    assert.equal(recoverPiParentSession(f.root, SESSION).ok, true);
  } finally { f.cleanup(); }
});

test("optional plan means an absent leaf, never an unreadable, corrupt or linked artifact", () => {
  for (const setup of [
    (f) => fs.writeFileSync(f.plan, ""),
    (f) => fs.writeFileSync(f.plan, "{broken"),
    (f) => fs.mkdirSync(f.plan),
    (f) => fs.symlinkSync(path.join(f.root, "nonexistent"), f.plan),
    (f) => fs.writeFileSync(f.plan, "x".repeat(1024 * 1024 + 1)),
  ]) {
    const f = draftFixture();
    try { setup(f); assert.equal(recoverPiParentSession(f.root, SESSION).ok, false); }
    finally { f.cleanup(); }
  }
});

test("a plan present during draft recovery still requires the exact canonical model route", () => {
  const f = draftFixture();
  const source = fixture();
  try {
    const plan = JSON.parse(fs.readFileSync(source.plan, "utf8"));
    fs.writeFileSync(f.plan, JSON.stringify(plan));
    const result = recoverPiParentSession(f.root, SESSION);
    assert.equal(result.ok, true, result.reason);
    assert.equal(JSON.parse(result.context.split("\n")[1]).stage, "draft");
    plan.model_strategy["plan-reviewer"] = "openai-codex/gpt-5.6-terra";
    fs.writeFileSync(f.plan, JSON.stringify(plan));
    assert.equal(recoverPiParentSession(f.root, SESSION).ok, false);
  } finally { f.cleanup(); source.cleanup(); }
});

test("native spec rewrite can resume with an existing plan while its old approvals stay unusable", () => {
  const f = fixture({ statePatch: { plan_review_evidence: { verdict: "APPROVE" }, hand_finished: ["parent-resume/task-one"] } });
  try {
    const written = writePiSpecDraft({ content: "# Revised requirements\n" }, { projectRoot: f.root, sessionId: SESSION });
    assert.equal(written.ok, true, written.reason);
    const before = fs.readFileSync(f.state);
    const result = recoverPiParentSession(f.root, SESSION);
    assert.equal(result.ok, true, result.reason);
    const envelope = JSON.parse(result.context.split("\n")[1]);
    assert.equal(envelope.stage, "draft");
    assert.equal(envelope.plan_approval, "not_verified_by_recovery");
    assert.equal(readPiSpecApproval({ projectRoot: f.root, sessionId: SESSION }).ok, false);
    assert.equal(decidePiDispatchGate({ projectRoot: f.root, sessionId: SESSION, subagentType: "harness-planner", env: {} }).decision, "deny");
    assert.deepEqual(fs.readFileSync(f.state), before);
  } finally { f.cleanup(); }
});

test("a draft with a legacy plan requires replanning against the current spec, not preservation of old tasks", () => {
  const f = fixture();
  try {
    const plan = JSON.parse(fs.readFileSync(f.plan, "utf8"));
    plan.model_strategy = LEGACY_MODELS;
    fs.writeFileSync(f.plan, JSON.stringify(plan));
    assert.equal(writePiSpecDraft({ content: "# Changed requirements\n" }, { projectRoot: f.root, sessionId: SESSION }).ok, true);
    const result = recoverPiParentSession(f.root, SESSION);
    assert.equal(result.ok, true, result.reason);
    const envelope = JSON.parse(result.context.split("\n")[1]);
    assert.equal(envelope.stage, "draft");
    assert.equal(envelope.model_route_reconciliation, undefined);
    assert.match(envelope.resume_guidance, /existing plan with the current specification and model route/);
  } finally { f.cleanup(); }
});

test("retoma somente a sessão pai local cujo plano e selo ainda conferem", () => {
  const f = fixture({ statePatch: { hand_finished: [`${FEATURE}/task-one`] } });
  try {
    const stateBefore = fs.readFileSync(f.state);
    const recovered = recoverPiParentSession(f.root, SESSION);
    assert.equal(recovered.ok, true);
    assert.equal(recovered.sessionId, SESSION);
    assert.equal(recovered.sessionFile.startsWith(f.sessions + path.sep), true);
    assert.equal(recovered.completedTaskIds, undefined, "hand_finished alone does not prove closure");
    assert.equal(recovered.pendingTaskIds, undefined, "recovery must not choose the next task");
    assert.match(recovered.context, /HARNESS_PARENT_RECOVERY/);
    assert.deepEqual(fs.readFileSync(f.state), stateBefore, "preflight nunca muda state");
  } finally { f.cleanup(); }
});

test("retoma uma cerimônia LIGHT preservando a identidade e o plano aprovados", () => {
  const f = fixture({ mode: "LIGHT" });
  try {
    const recovered = recoverPiParentSession(f.root, SESSION);
    assert.equal(recovered.ok, true);
    const envelope = JSON.parse(recovered.context.split("\n")[1]);
    assert.equal(envelope.session_id, SESSION);
    assert.equal(envelope.feature_id, FEATURE);
    assert.equal(envelope.canonical_plan_sha256, sha(fs.readFileSync(f.plan, "utf8")));
  } finally { f.cleanup(); }
});

test("recovery exposes evidence without inventing plan approval or task closure", () => {
  // A planner may have written this structurally valid plan before a reviewer ran.
  // Likewise a finished hand may still need capture, compliance and adversary.
  const f = fixture({ statePatch: {
    hand_finished: [`${FEATURE}/task-one`],
    regate_pending: [`${FEATURE}/task-one`],
    regate_passed: [`${FEATURE}/task-one@old-head`],
  } });
  try {
    const result = recoverPiParentSession(f.root, SESSION);
    assert.equal(result.ok, true, "the same conversation can reopen to finish its review");
    const envelope = JSON.parse(result.context.split("\n")[1]);
    assert.equal(envelope.plan_approval, "not_verified_by_recovery");
    assert.equal(envelope.canonical_plan_sha256, sha(fs.readFileSync(f.plan, "utf8")));
    assert.equal(envelope.gate_state_path, path.relative(f.root, f.state));
    assert.equal(envelope.session_file, path.relative(f.root, result.sessionFile));
    assert.equal(envelope.spec_path, path.relative(f.root, f.specPath));
    for (const name of ["completed_task_ids", "pending_task_ids", "unresolved_regates"]) {
      assert.equal(Object.hasOwn(envelope, name), false, `${name} needs current review evidence, not historical flags`);
    }
    assert.equal(result.unresolvedRegates, undefined, "old HEAD passes cannot close a current regate");
  } finally { f.cleanup(); }
});

test("recovery accepts only the exact legacy reviewer route and requires its reconciliation", () => {
  const f = fixture();
  try {
    const plan = JSON.parse(fs.readFileSync(f.plan, "utf8"));
    plan.model_strategy = LEGACY_MODELS;
    fs.writeFileSync(f.plan, JSON.stringify(plan));
    const recovered = recoverPiParentSession(f.root, SESSION);
    assert.equal(recovered.ok, true);
    const envelope = JSON.parse(recovered.context.split("\n")[1]);
    assert.equal(envelope.plan_approval, "not_verified_by_recovery");
    assert.equal(envelope.model_route_status, "legacy-plan-reviewer-sol");
    assert.match(envelope.model_route_reconciliation, /planner.*model_strategy\.plan-reviewer.*Astra.*new hash/is);
  } finally { f.cleanup(); }
});

test("recovery rejects a strategy that differs from both exact route snapshots", () => {
  const f = fixture();
  try {
    const plan = JSON.parse(fs.readFileSync(f.plan, "utf8"));
    plan.model_strategy["plan-reviewer"] = "openai-codex/gpt-5.6-terra";
    fs.writeFileSync(f.plan, JSON.stringify(plan));
    assert.deepEqual(recoverPiParentSession(f.root, SESSION), { ok: false, reason: "resume plan invalid" });
  } finally { f.cleanup(); }
});

test("recusa sessão de outra worktree, mesmo quando o JSONL está no diretório local", () => {
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-other-worktree-")));
  const f = fixture({ headerCwd: other });
  try {
    assert.deepEqual(recoverPiParentSession(f.root, SESSION), { ok: false, reason: "resume session cwd mismatch" });
  } finally { f.cleanup(); fs.rmSync(other, { recursive: true, force: true }); }
});

test("aceita transcript longo: lê só o cabeçalho, sem limitar a sessão pela carga de conversa", () => {
  const f = fixture();
  try {
    const session = path.join(f.sessions, `2026-01-01T00-00-00-000Z_${SESSION}.jsonl`);
    fs.appendFileSync(session, "x".repeat(1024 * 1024 + 1));
    assert.equal(recoverPiParentSession(f.root, SESSION).ok, true);
  } finally { f.cleanup(); }
});

test("recusa state/spec divergentes e nunca cria uma sessão nova", () => {
  const stale = "0".repeat(64);
  const f = fixture({ statePatch: { spec_sha256: stale, adversary_spec_sha256: stale, reviewed_spec_sha256: stale } });
  try {
    assert.deepEqual(recoverPiParentSession(f.root, SESSION), { ok: false, reason: "resume spec hash mismatch" });
    assert.deepEqual(recoverPiParentSession(f.root, "ses-not-found"), { ok: false, reason: "resume session file missing" });
  } finally { f.cleanup(); }
});

test("o mesmo lock de worktree serializa início fresh e retomada de qualquer session id", () => {
  const f = fixture();
  try {
    const identity = (pid) => ({ pid, state: "S", start: `start-${pid}` });
    const first = acquirePiParentWorktreeLock(f.root, {
      sessionId: null, pid: 12345, hostname: "same-host", processIdentityFn: identity,
    });
    assert.equal(first.ok, true);
    assert.deepEqual(acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "same-host", processIdentityFn: identity,
    }), { ok: false, reason: "parent orchestrator already active for worktree" });
    first.release();
    const next = acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "same-host", processIdentityFn: identity,
    });
    assert.equal(next.ok, true);
    next.release();
  } finally { f.cleanup(); }
});

test("retomada exata substitui lock órfão quando a identidade do processo prova término", () => {
  const f = fixture();
  try {
    const abandoned = acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 12345, hostname: "host-a",
      processIdentityFn: (pid) => ({ pid, state: "S", start: "old-start" }),
    });
    assert.equal(abandoned.ok, true);

    const resumed = acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "host-b",
      processIdentityFn: (pid) => pid === 54321 ? { pid, state: "S", start: "new-start" } : null,
    });
    assert.deepEqual(resumed, { ok: false, reason: "parent orchestrator already active for worktree" }, "foreign host cannot take over");

    const exact = acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "host-a",
      processIdentityFn: (pid) => pid === 54321 ? { pid, state: "S", start: "new-start" } : null,
    });
    assert.equal(exact.ok, true);
    assert.equal(exact.recovered, true);
    assert.equal(abandoned.release(), false, "old token cannot release the recovered owner");
    exact.release();
  } finally { f.cleanup(); }
});

test("retomada exata não substitui processo vivo nem identidade indeterminada", () => {
  for (const [label, prior] of [
    ["live", { pid: 12345, state: "S", start: "old-start" }],
    ["indeterminate", undefined],
  ]) {
    const f = fixture();
    try {
      const first = acquirePiParentWorktreeLock(f.root, {
        sessionId: SESSION, pid: 12345, hostname: "host-a",
        processIdentityFn: (pid) => ({ pid, state: "S", start: "old-start" }),
      });
      assert.equal(first.ok, true);
      const next = acquirePiParentWorktreeLock(f.root, {
        sessionId: SESSION, pid: 54321, hostname: "host-a",
        processIdentityFn: (pid) => pid === 54321 ? { pid, state: "S", start: "new-start" } : prior,
      });
      assert.deepEqual(next, { ok: false, reason: "parent orchestrator already active for worktree" }, label);
      first.release();
    } finally { f.cleanup(); }
  }
});

test("fresh orphan recovery proves registered workers and groups ended before taking the lock", () => {
  for (const observation of ["ended", "worker", "group", "terminal", "terminal-unknown", "unknown"]) {
    const f = fixture();
    try {
      const abandoned = acquirePiParentWorktreeLock(f.root, { sessionId: SESSION, pid: 12345, hostname: "host-a",
        processIdentityFn: (pid) => ({ pid, state: "S", start: "old" }) });
      assert.equal(abandoned.ok, true);
      const registryPath = path.join(f.root, ".pi/harness/state", SESSION, "task-runs/index.json");
      fs.mkdirSync(path.dirname(registryPath), { recursive: true });
      const launch = { run_id: "run-one", ...(observation.startsWith("terminal") ? { terminal_mode: true } : {}) };
      fs.writeFileSync(registryPath, JSON.stringify({ tasks: { one: { launches: [launch] } } }));
      const recovered = acquirePiParentWorktreeLock(f.root, { sessionId: "fresh-new-session", pid: 54321, hostname: "host-a",
        processIdentityFn: (pid) => pid === 54321 ? { pid, state: "S", start: "new" } : null,
        readTaskProcessFn: () => ({ running: observation === "worker", terminal: !observation.endsWith("unknown"), record: { process_group: 98765 } }),
        groupMembersFn: () => observation === "group" ? [{ pid: 98766 }] : [],
        workerPidsFn: () => [],
      });
      assert.equal(recovered.ok, ["ended", "terminal"].includes(observation), observation);
      if (recovered.ok) { assert.equal(abandoned.release(), false); recovered.release(); }
      else { assert.equal(abandoned.release(), true); }
    } finally { f.cleanup(); }
  }
});

test("orphan recovery ignores foreign historic registries and refuses ambiguous legacy task ownership", () => {
  for (const ownerSession of [SESSION, null]) {
    const f = fixture();
    try {
      const first = acquirePiParentWorktreeLock(f.root, { sessionId: ownerSession, pid: 12345, hostname: "same",
        processIdentityFn: (pid) => ({ pid, state: "S", start: "old" }) });
      const foreign = path.join(f.root, ".pi/harness/state", "historic-session", "task-runs");
      fs.mkdirSync(foreign, { recursive: true });
      fs.writeFileSync(path.join(foreign, "index.json"), "unavailable historic registry");
      const recovered = acquirePiParentWorktreeLock(f.root, { sessionId: "new-session", pid: 54321, hostname: "same",
        processIdentityFn: (pid) => pid === 54321 ? { pid, state: "S", start: "new" } : null });
      assert.equal(recovered.ok, ownerSession === SESSION);
      if (recovered.ok) recovered.release(); else first.release();
    } finally { f.cleanup(); }
  }
});

test("Darwin fixa a invocação de ps e devolve uma identidade de início estável", () => {
  const calls = [];
  const identity = darwinProcessIdentity(4321, {
    env: { PATH: "/test-bin", LC_ALL: "pt_BR.UTF-8", LANG: "pt_BR.UTF-8", TZ: "America/Fortaleza" },
    spawnSyncFn: (...args) => {
      calls.push(args);
      return { status: 0, stdout: "S+   Wed Sep  9 08:07:06 2026\n", stderr: "" };
    },
    killFn: () => { throw new Error("kill fallback must not run for valid ps output"); },
  });

  assert.deepEqual(identity, { pid: 4321, state: "S+", start: "Wed Sep 9 08:07:06 2026" });
  assert.equal(calls.length, 1);
  const [command, argv, options] = calls[0];
  assert.equal(command, "/bin/ps");
  assert.deepEqual(argv, ["-p", "4321", "-o", "state=", "-o", "lstart="]);
  assert.equal(options.shell, false);
  assert.equal(options.encoding, "utf8");
  assert.equal(Number.isInteger(options.timeout) && options.timeout > 0 && options.timeout <= 5_000, true);
  assert.equal(Number.isInteger(options.maxBuffer) && options.maxBuffer > 0 && options.maxBuffer <= 64 * 1024, true);
  assert.deepEqual(options.env, { PATH: "/test-bin", LC_ALL: "C", LANG: "C", TZ: "UTC" });
});

test("Darwin preserva estados zombie para o lock recusar a identidade", () => {
  for (const state of ["Z", "Z+"]) {
    const identity = darwinProcessIdentity(4321, {
      spawnSyncFn: () => ({ status: 0, stdout: `${state} Tue Jan 13 14:25:26 2026\n`, stderr: "" }),
      killFn: () => { throw new Error("valid ps output must not use kill fallback"); },
    });
    assert.deepEqual(identity, { pid: 4321, state, start: "Tue Jan 13 14:25:26 2026" });
  }
});

test("Darwin só prova ausência quando kill(pid, 0) confirma ESRCH", () => {
  const killCalls = [];
  const identity = darwinProcessIdentity(4321, {
    spawnSyncFn: () => ({ status: 1, stdout: "", stderr: "" }),
    killFn: (...args) => {
      killCalls.push(args);
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    },
  });

  assert.equal(identity, null);
  assert.deepEqual(killCalls, [[4321, 0]]);
});

test("Darwin falha fechado quando ps falha mas o PID ainda está vivo ou inacessível", () => {
  for (const [label, killFn] of [
    ["live", () => undefined],
    ["eperm", () => { const error = new Error("not permitted"); error.code = "EPERM"; throw error; }],
  ]) {
    const identity = darwinProcessIdentity(4321, {
      spawnSyncFn: () => ({ status: 1, stdout: "", stderr: "" }),
      killFn,
    });
    assert.equal(identity, undefined, label);
  }
});

test("Darwin falha fechado para erro, timeout e saída de ps inválida", () => {
  const cases = [
    ["spawn throws", () => { throw new Error("spawn failed"); }],
    ["timeout", () => ({ status: null, signal: "SIGTERM", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }), stdout: "", stderr: "" })],
    ["empty", () => ({ status: 0, stdout: "", stderr: "" })],
    ["multiple", () => ({ status: 0, stdout: "S Wed Sep 9 08:07:06 2026\nS Wed Sep 9 08:07:07 2026\n", stderr: "" })],
    ["malformed", () => ({ status: 0, stdout: "S sometime yesterday\n", stderr: "" })],
    ["non-ascii", () => ({ status: 0, stdout: "S Qua Set 9 08:07:06 2026\n", stderr: "" })],
  ];

  for (const [label, spawnSyncFn] of cases) {
    const identity = darwinProcessIdentity(4321, { spawnSyncFn, killFn: () => undefined });
    assert.equal(identity, undefined, label);
  }
});

test("Linux encontra starttime mesmo quando o nome do processo contém parêntese fechado", () => {
  const fields = ["S", ...Array.from({ length: 18 }, (_, index) => String(index + 1)), "424242", "21"];
  const identity = linuxProcessIdentity(4321, {
    readFileSyncFn: (file, encoding) => {
      assert.equal(file, "/proc/4321/stat");
      assert.equal(encoding, "utf8");
      return `4321 (worker ) helper) ${fields.join(" ")}`;
    },
  });

  assert.deepEqual(identity, { pid: 4321, state: "S", start: "424242" });
});
