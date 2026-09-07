import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquirePiParentWorktreeLock, recoverPiParentSession } from "./parent-session-recovery.mjs";

const SESSION = "ses-parent-resume";
const FEATURE = "parent-resume";
const MODELS = {
  hand_tiers: { low: "openai-codex/gpt-5.6-luna", medium: "openai-codex/gpt-5.6-terra", high: "openai-codex/gpt-5.6-terra" },
  planner: "openai-codex/gpt-5.6-sol", "plan-reviewer": "openai-codex/gpt-6-astra", compliance: "openai-codex/gpt-5.6-luna",
  adversary: "openai-codex/gpt-5.6-sol", security: "openai-codex/gpt-5.6-sol", shipper: "openai-codex/gpt-5.6-luna", harvester: "openai-codex/gpt-5.6-luna",
};
const LEGACY_MODELS = { ...MODELS, compliance: "openai-codex/gpt-5.6-terra" };

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

test("recovery accepts only the exact legacy compliance route and requires its reconciliation", () => {
  const f = fixture();
  try {
    const plan = JSON.parse(fs.readFileSync(f.plan, "utf8"));
    plan.model_strategy = LEGACY_MODELS;
    fs.writeFileSync(f.plan, JSON.stringify(plan));
    const recovered = recoverPiParentSession(f.root, SESSION);
    assert.equal(recovered.ok, true);
    const envelope = JSON.parse(recovered.context.split("\n")[1]);
    assert.equal(envelope.plan_approval, "not_verified_by_recovery");
    assert.equal(envelope.model_route_status, "legacy-compliance-terra");
    assert.match(envelope.model_route_reconciliation, /planner.*model_strategy\.compliance.*Luna.*new hash/is);
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
    const first = acquirePiParentWorktreeLock(f.root, {
      sessionId: null, pid: 12345, hostname: "same-host",
    });
    assert.equal(first.ok, true);
    assert.deepEqual(acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "same-host",
    }), { ok: false, reason: "parent orchestrator already active for worktree" });
    first.release();
    const next = acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "same-host",
    });
    assert.equal(next.ok, true);
    next.release();
  } finally { f.cleanup(); }
});

test("lock de worktree fica fail-closed após crash porque o Pi filho pode sobreviver ao launcher", () => {
  const f = fixture();
  try {
    const abandoned = acquirePiParentWorktreeLock(f.root, {
      sessionId: "fresh-session", pid: 12345, hostname: "host-a",
    });
    assert.equal(abandoned.ok, true);

    assert.deepEqual(acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "host-b",
    }), { ok: false, reason: "parent orchestrator already active for worktree" });

    assert.deepEqual(acquirePiParentWorktreeLock(f.root, {
      sessionId: SESSION, pid: 54321, hostname: "host-a",
    }), { ok: false, reason: "parent orchestrator already active for worktree" });
    abandoned.release();
  } finally { f.cleanup(); }
});
