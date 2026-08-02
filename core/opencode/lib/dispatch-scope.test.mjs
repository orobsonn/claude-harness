/** @description Exact call-keyed dispatch scope records. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import {
  bindChildSession,
  claimActiveDispatch,
  claimDispatchForRuntime,
  normalizeProjectPath,
  readDispatchRecord,
  removeDispatchRecord,
  resolveFixModeScopeAuthority,
} from "./dispatch-scope.mjs";
import { acquireLock, releaseLock } from "./gate-state.mjs";
import { semanticPlanHash } from "./planner-artifact.mjs";

const MODEL_STRATEGY = { hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" }, planner: "openai/planner", "plan-reviewer": "openai/reviewer", compliance: "openai/compliance", adversary: "openai/adversary", security: "openai/security", shipper: "openai/shipper", harvester: "openai/harvester" };

function fixture(tasks = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-scope-"));
  const sessionId = "ses-scope";
  const featureId = "feat-scope";
  const plan = { feature_id: featureId, kind: "full", mode: "full", model_strategy: MODEL_STRATEGY, tasks: tasks ?? [
    { id: "task-1", severity: "medium", complexity: "medium", scope_paths: ["src/a.ts"], criterion_refs: ["#ac-1"], locked_tests: [{ id: "lt-1", path: "tests/a.test.mjs", assertion: "a" }] },
  ] };
  const bytes = Buffer.from(JSON.stringify(plan));
  const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
  const relative = `.opencode/plans/.state/${sessionId}/bound-plans/${fileHash}.json`;
  fs.mkdirSync(path.join(stateDir, "bound-plans"), { recursive: true });
  fs.writeFileSync(path.join(root, relative), bytes);
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({ session_id: sessionId, feature_id: featureId, planner_status: "usable", planner_plan_binding: { session_id: sessionId, feature_id: featureId, snapshot_path: relative, snapshot_hash: semanticPlanHash(plan), snapshot_file_hash: fileHash } }));
  return { root, sessionId, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function recordPath(f, callId) {
  return path.join(f.root, ".opencode", "plans", ".state", f.sessionId, "dispatch-records", `${crypto.createHash("sha256").update(callId).digest("hex")}.json`);
}

const FIX_REVIEWED_SHA = "abc123abc123abc123abc123abc123abc123abcd";

function fixModeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-fix-scope-"));
  const sessionId = "ses-fix-scope";
  const featureId = "feat-fix-scope";
  fs.mkdirSync(path.join(root, "src", "dir"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "a\n");
  fs.writeFileSync(path.join(root, "src", "b.ts"), "b\n");
  fs.symlinkSync("a.ts", path.join(root, "src", "link.ts"));
  const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: sessionId,
    feature_id: featureId,
    classified: true,
    mode: "LIGHT",
    planner_status: "not_started",
    planner_plan_binding: null,
  }));
  return { root, sessionId, featureId, close: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function fixModeEnv(scopePaths) {
  return {
    HARNESS_FIX_MODE: "1",
    HARNESS_FIX_SCOPE_JSON: JSON.stringify({
      version: 1,
      reviewed_sha: FIX_REVIEWED_SHA,
      scope_paths: scopePaths,
    }),
  };
}

test("fix-mode authority creates the same exact call record without inventing a planner snapshot", () => {
  const f = fixModeFixture();
  try {
    const env = fixModeEnv(["src/a.ts", "src/b.ts"]);
    assert.deepEqual(resolveFixModeScopeAuthority(env), {
      enabled: true,
      ok: true,
      reviewedSha: FIX_REVIEWED_SHA,
      scopePaths: ["src/a.ts", "src/b.ts"],
    });
    const claim = claimDispatchForRuntime(f.root, {
      sessionId: f.sessionId,
      callId: "fix-call",
      role: "sniper-high",
      taskId: "fix-task",
      featureId: f.featureId,
      now: 1_000,
    }, { env, isAncestorFn: () => true });
    assert.equal(claim.ok, true, claim.reason);
    assert.equal(claim.reviewedSha, FIX_REVIEWED_SHA);
    assert.deepEqual(readDispatchRecord(f.root, {
      parentSessionId: f.sessionId,
      callId: "fix-call",
    }).record, {
      parent_session_id: f.sessionId,
      dispatch_call_id: "fix-call",
      child_session_id: null,
      feature_id: f.featureId,
      task_id: "fix-task",
      role: "sniper-high",
      scope_paths: ["src/a.ts", "src/b.ts"],
      allowed_writes: [],
      frozen_paths: [],
      snapshot_hash: claim.claim.snapshot_hash,
      claimed_at: "1970-01-01T00:00:01.000Z",
    });
    assert.match(claim.claim.snapshot_hash, /^[0-9a-f]{64}$/);

    const replay = claimDispatchForRuntime(f.root, {
      sessionId: f.sessionId,
      callId: "fix-call",
      role: "sniper-high",
      taskId: "fix-task",
      featureId: f.featureId,
      now: 2_000,
    }, { env, isAncestorFn: () => true });
    assert.equal(replay.ok, true);
    assert.equal(replay.claim.claimed_at, "1970-01-01T00:00:01.000Z");

    const bound = bindChildSession(f.root, {
      parentSessionId: f.sessionId,
      childSessionId: "ses-fix-child",
      role: "sniper-low",
      callId: "fix-call",
    });
    assert.equal(bound.ok, true, bound.reason);
  } finally { f.close(); }
});

test("fix-mode authority fails closed on widening, stale identity, wrong role, and replay conflict", () => {
  const f = fixModeFixture();
  try {
    for (const [label, env] of [
      ["missing envelope", { HARNESS_FIX_MODE: "1" }],
      ["malformed envelope", { HARNESS_FIX_MODE: "1", HARNESS_FIX_SCOPE_JSON: "{" }],
      ["root scope", fixModeEnv(["."])],
      ["directory scope", fixModeEnv(["src/dir"])],
      ["symlink scope", fixModeEnv(["src/link.ts"])],
      ["traversal", fixModeEnv(["src/../b.ts"])],
      ["windows absolute", fixModeEnv(["C:/Windows/system.ini"])],
      ["duplicates", fixModeEnv(["src/a.ts", "src/a.ts"])],
      ["overflow", fixModeEnv(Array.from({ length: 101 }, (_, index) => `src/f${index}.ts`))],
    ]) {
      const result = claimDispatchForRuntime(f.root, {
        sessionId: f.sessionId,
        callId: `bad-${label.replaceAll(" ", "-")}`,
        role: "sniper-low",
        taskId: "fix-task",
        featureId: f.featureId,
      }, { env, isAncestorFn: () => true });
      assert.equal(result.ok, false, label);
    }

    for (const role of ["executor-low", "test-author"]) {
      const result = claimDispatchForRuntime(f.root, {
        sessionId: f.sessionId,
        callId: `bad-role-${role}`,
        role,
        taskId: "fix-task",
        featureId: f.featureId,
      }, { env: fixModeEnv(["src/a.ts"]), isAncestorFn: () => true });
      assert.equal(result.ok, false, role);
    }

    assert.equal(claimDispatchForRuntime(f.root, {
      sessionId: f.sessionId,
      callId: "stale-sha",
      role: "sniper-low",
      taskId: "fix-task",
      featureId: f.featureId,
    }, { env: fixModeEnv(["src/a.ts"]), isAncestorFn: () => false }).ok, false);
    assert.equal(claimDispatchForRuntime(f.root, {
      sessionId: f.sessionId,
      callId: "wrong-feature",
      role: "sniper-low",
      taskId: "fix-task",
      featureId: "other-feature",
    }, { env: fixModeEnv(["src/a.ts"]), isAncestorFn: () => true }).ok, false);

    const first = claimDispatchForRuntime(f.root, {
      sessionId: f.sessionId,
      callId: "conflict-call",
      role: "sniper-low",
      taskId: "fix-task",
      featureId: f.featureId,
    }, { env: fixModeEnv(["src/a.ts"]), isAncestorFn: () => true });
    assert.equal(first.ok, true);
    const conflict = claimDispatchForRuntime(f.root, {
      sessionId: f.sessionId,
      callId: "conflict-call",
      role: "sniper-low",
      taskId: "fix-task",
      featureId: f.featureId,
    }, { env: fixModeEnv(["src/b.ts"]), isAncestorFn: () => true });
    assert.equal(conflict.ok, false);
  } finally { f.close(); }
});

test("concurrent fix-mode calls keep independent exact records", async () => {
  const f = fixModeFixture();
  try {
    const env = fixModeEnv(["src/a.ts"]);
    const [left, right] = await Promise.all([
      Promise.resolve().then(() => claimDispatchForRuntime(f.root, {
        sessionId: f.sessionId, callId: "fix-left", role: "sniper-low",
        taskId: "fix-left-task", featureId: f.featureId,
      }, { env, isAncestorFn: () => true })),
      Promise.resolve().then(() => claimDispatchForRuntime(f.root, {
        sessionId: f.sessionId, callId: "fix-right", role: "sniper-high",
        taskId: "fix-right-task", featureId: f.featureId,
      }, { env, isAncestorFn: () => true })),
    ]);
    assert.equal(left.ok, true, left.reason);
    assert.equal(right.ok, true, right.reason);
    assert.equal(removeDispatchRecord(f.root, { sessionId: f.sessionId, callId: "fix-left" }).ok, true);
    assert.equal(readDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "fix-left" }).ok, false);
    assert.equal(readDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "fix-right" }).ok, true);
  } finally { f.close(); }
});

function bindFromWorker(root, callId, childSessionId, barrier) {
  const workerSource = `
    import { parentPort, workerData } from "node:worker_threads";
    import { bindChildSession } from ${JSON.stringify(new URL("./dispatch-scope.mjs", import.meta.url).href)};
    const view = new Int32Array(workerData.barrier);
    Atomics.add(view, 0, 1);
    Atomics.notify(view, 0);
    while (Atomics.load(view, 0) < 2) Atomics.wait(view, 0, Atomics.load(view, 0));
    parentPort.postMessage(bindChildSession(workerData.root, {
      parentSessionId: "ses-scope",
      childSessionId: workerData.childSessionId,
      role: "executor-low",
      callId: workerData.callId,
    }));
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, { eval: true, workerData: { root, callId, childSessionId, barrier } });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (code) => { if (code !== 0) reject(new Error(`worker exited ${code}`)); });
  });
}

test("concurrent calls create independent records and left cleanup leaves right byte-stable", () => {
  const f = fixture([
    { id: "left", severity: "medium", complexity: "medium", scope_paths: ["src/left.ts"], criterion_refs: ["#left"], locked_tests: [{ id: "l", path: "tests/left.test.mjs", assertion: "left" }] },
    { id: "right", severity: "medium", complexity: "medium", scope_paths: ["src/right.ts"], criterion_refs: ["#right"], locked_tests: [{ id: "r", path: "tests/right.test.mjs", assertion: "right" }] },
  ]);
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "left-call", role: "executor-low", taskId: "left" }).ok, true);
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "right-call", role: "executor-high", taskId: "right" }).ok, true);
    const rightPath = recordPath(f, "right-call");
    const rightBefore = fs.readFileSync(rightPath);
    assert.equal(removeDispatchRecord(f.root, { sessionId: f.sessionId, callId: "left-call" }).ok, true);
    assert.equal(fs.existsSync(recordPath(f, "left-call")), false);
    assert.deepEqual(fs.readFileSync(rightPath), rightBefore);
  } finally { f.close(); }
});

test("claim stores the exact required record outside shared gate-state", () => {
  const f = fixture();
  try {
    const claim = claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "exact-call", role: "executor-high", taskId: "task-1", now: 1_000 });
    assert.equal(claim.ok, true, claim.reason);
    assert.deepEqual(JSON.parse(fs.readFileSync(recordPath(f, "exact-call"), "utf8")), {
      parent_session_id: f.sessionId, dispatch_call_id: "exact-call", child_session_id: null,
      feature_id: "feat-scope", task_id: "task-1", role: "executor-high",
      scope_paths: ["src/a.ts"], allowed_writes: [], frozen_paths: ["tests/a.test.mjs"], snapshot_hash: claim.claim.snapshot_hash,
      claimed_at: "1970-01-01T00:00:01.000Z",
    });
    const state = JSON.parse(fs.readFileSync(path.join(f.root, ".opencode", "plans", ".state", f.sessionId, "gate-state.json"), "utf8"));
    assert.equal(state.dispatch_records, undefined);
  } finally { f.close(); }
});

test("claim records a stable baseline for dirty files that predate the exact hand dispatch", () => {
  const f = fixture();
  const git = (...args) => execFileSync("git", args, { cwd: f.root, stdio: "ignore" });
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.writeFileSync(path.join(f.root, ".gitignore"), ".opencode/plans/.state/\n");
    fs.writeFileSync(path.join(f.root, "tracked.txt"), "baseline\n");
    git("add", ".gitignore", "tracked.txt");
    git("commit", "-m", "baseline");
    fs.writeFileSync(path.join(f.root, "MEMORY.md"), "vendored before task\n");

    const claim = claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "baseline-call", role: "executor-low", taskId: "task-1" });
    assert.equal(claim.ok, true, claim.reason);
    const record = readDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "baseline-call" });
    assert.equal(record.ok, true, record.reason);
    assert.deepEqual(record.record.worktree_baseline?.entries.map((entry) => entry.path), ["MEMORY.md"]);
    assert.equal(record.record.worktree_baseline?.entries[0]?.fingerprint.kind, "file");

    const before = fs.readFileSync(recordPath(f, "baseline-call"));
    fs.writeFileSync(path.join(f.root, "MEMORY.md"), "changed after dispatch\n");
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "baseline-call", role: "executor-low", taskId: "task-1" }).ok, true);
    assert.deepEqual(fs.readFileSync(recordPath(f, "baseline-call")), before);
  } finally { f.close(); }
});

test("a malformed optional worktree baseline does not invalidate dispatch authority", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "optional-baseline", role: "executor-low", taskId: "task-1" }).ok, true);
    const file = recordPath(f, "optional-baseline");
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...record, worktree_baseline: { version: 99, entries: [] } }));
    assert.equal(readDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "optional-baseline" }).ok, true);
  } finally { f.close(); }
});

test("claim shares the session lifecycle lock with retention cleanup", () => {
  const f = fixture();
  const lifecycle = path.join(f.root, ".opencode", "plans", ".state", ".session-lifecycle", f.sessionId);
  const acquired = acquireLock(lifecycle);
  try {
    assert.equal(acquired.ok, true);
    const claim = claimActiveDispatch(f.root, {
      sessionId: f.sessionId,
      callId: "lifecycle-blocked",
      role: "executor-low",
      taskId: "task-1",
      lockOptions: { timeoutMs: 5, retryMs: 1, staleMs: 60_000 },
    });
    assert.equal(claim.ok, false);
    assert.match(claim.reason, /lock-timeout/);
    assert.equal(fs.existsSync(recordPath(f, "lifecycle-blocked")), false);
  } finally {
    if (acquired.ok) releaseLock(lifecycle, acquired.token);
    f.close();
  }
});

test("present exact records fail as conflicts unless their complete schema is canonical", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "schema", role: "executor-low", taskId: "task-1" }).ok, true);
    const valid = JSON.parse(fs.readFileSync(recordPath(f, "schema"), "utf8"));
    const invalidRecords = [
      { ...valid, feature_id: "" },
      { ...valid, feature_id: "Not-Kebab" },
      { ...valid, task_id: "../task" },
      { ...valid, role: "planner" },
      { ...valid, snapshot_hash: "not-a-sha256" },
      { ...valid, child_session_id: "../other" },
      { ...valid, claimed_at: "not-an-iso-timestamp" },
      { ...valid, scope_paths: ["src/a.ts", 7] },
      { ...valid, allowed_writes: [null] },
      { ...valid, scope_paths: [] },
      { ...valid, scope_paths: ["src/a.ts", "src/a.ts"] },
      { ...valid, scope_paths: ["src/../outside.ts"] },
    ];
    for (const malformed of invalidRecords) {
      fs.writeFileSync(recordPath(f, "schema"), JSON.stringify(malformed));
      const read = readDispatchRecord(f.root, { parentSessionId: f.sessionId, callId: "schema" });
      assert.equal(read.ok, false, JSON.stringify(malformed));
      assert.equal(read.conflict, true, JSON.stringify(malformed));
    }
  } finally { f.close(); }
});

test("same call changed task or role denies replay", () => {
  const f = fixture([
    { id: "left", severity: "medium", complexity: "medium", scope_paths: ["src/left.ts"], criterion_refs: ["#left"], locked_tests: [{ id: "l", path: "tests/left.test.mjs", assertion: "left" }] },
    { id: "right", severity: "medium", complexity: "medium", scope_paths: ["src/right.ts"], criterion_refs: ["#right"], locked_tests: [{ id: "r", path: "tests/right.test.mjs", assertion: "right" }] },
  ]);
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "same", role: "executor-low", taskId: "left" }).ok, true);
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "same", role: "executor-low", taskId: "right" }).ok, false);
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "same", role: "sniper-low", taskId: "left" }).ok, false);
  } finally { f.close(); }
});

test("identical same-call replay is idempotent and byte-stable", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "same", role: "executor-low", taskId: "task-1", now: 1_000 }).ok, true);
    const before = fs.readFileSync(recordPath(f, "same"));
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "same", role: "executor-low", taskId: "task-1", now: 2_000 }).ok, true);
    assert.deepEqual(fs.readFileSync(recordPath(f, "same")), before);
  } finally { f.close(); }
});

test("claim rejects unusable or invalid canonical planner state", () => {
  const f = fixture();
  try {
    const statePath = path.join(f.root, ".opencode", "plans", ".state", f.sessionId, "gate-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    fs.writeFileSync(statePath, JSON.stringify({ ...state, planner_status: "pending" }));
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "bad-state", role: "executor-low", taskId: "task-1" }).ok, false);
    fs.writeFileSync(statePath, JSON.stringify({ ...state, planner_plan_binding: { ...state.planner_plan_binding, snapshot_hash: "bad" } }));
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "bad-snapshot", role: "executor-low", taskId: "task-1" }).ok, false);
  } finally { f.close(); }
});

test("cleanup of an absent exact call cannot remove a sibling record", () => {
  const f = fixture();
  try {
    claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "right", role: "executor-low", taskId: "task-1" });
    const before = fs.readFileSync(recordPath(f, "right"));
    assert.equal(removeDispatchRecord(f.root, { sessionId: f.sessionId, callId: "wrong" }).ok, true);
    assert.deepEqual(fs.readFileSync(recordPath(f, "right")), before);
  } finally { f.close(); }
});

test("child binding requires its exact call and cannot rebind to another call", () => {
  const f = fixture([
    { id: "left", severity: "medium", complexity: "medium", scope_paths: ["src/left.ts"], criterion_refs: ["#left"], locked_tests: [{ id: "l", path: "tests/left.test.mjs", assertion: "left" }] },
    { id: "right", severity: "medium", complexity: "medium", scope_paths: ["src/right.ts"], criterion_refs: ["#right"], locked_tests: [{ id: "r", path: "tests/right.test.mjs", assertion: "right" }] },
  ]);
  try {
    claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "left", role: "executor-low", taskId: "left" });
    claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "right", role: "executor-high", taskId: "right" });
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child", role: "executor-low" }).ok, false);
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child", role: "executor-low", callId: "left" }).ok, true);
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child", role: "executor-high", callId: "right" }).ok, false);
  } finally { f.close(); }
});

test("concurrent calls racing for one child have exactly one binding winner", async () => {
  const f = fixture([
    { id: "left", severity: "medium", complexity: "medium", scope_paths: ["src/left.ts"], criterion_refs: ["#left"], locked_tests: [{ id: "l", path: "tests/left.test.mjs", assertion: "left" }] },
    { id: "right", severity: "medium", complexity: "medium", scope_paths: ["src/right.ts"], criterion_refs: ["#right"], locked_tests: [{ id: "r", path: "tests/right.test.mjs", assertion: "right" }] },
  ]);
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "left", role: "executor-low", taskId: "left" }).ok, true);
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "right", role: "executor-low", taskId: "right" }).ok, true);
    const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    const results = await Promise.all([
      bindFromWorker(f.root, "left", "shared-child", barrier),
      bindFromWorker(f.root, "right", "shared-child", barrier),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    const bound = ["left", "right"].map((callId) => JSON.parse(fs.readFileSync(recordPath(f, callId), "utf8"))).filter((record) => record.child_session_id === "shared-child");
    assert.equal(bound.length, 1);
  } finally { f.close(); }
});

test("root-alias bind replay is idempotent and byte-stable", () => {
  const f = fixture();
  const alias = `${f.root}-bind-alias`;
  try {
    fs.symlinkSync(f.root, alias, "dir");
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "alias-replay", role: "executor-low", taskId: "task-1" }).ok, true);
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child-alias", role: "executor-low", callId: "alias-replay" }).ok, true);
    const before = fs.readFileSync(recordPath(f, "alias-replay"));
    assert.equal(bindChildSession(alias, { parentSessionId: f.sessionId, childSessionId: "child-alias", role: "executor-low", callId: "alias-replay" }).ok, true);
    assert.deepEqual(fs.readFileSync(recordPath(f, "alias-replay")), before);
  } finally {
    try { fs.unlinkSync(alias); } catch { /* unavailable */ }
    f.close();
  }
});

test("child binding fails closed when the sibling record scan faults", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "scan-fault", role: "executor-low", taskId: "task-1" }).ok, true);
    const broken = path.join(f.root, ".opencode", "plans", ".state", "broken-session");
    fs.mkdirSync(broken, { recursive: true });
    fs.writeFileSync(path.join(broken, "dispatch-records"), "not-a-directory");
    const result = bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child-scan", role: "executor-low", callId: "scan-fault" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /scan/i);
    assert.equal(JSON.parse(fs.readFileSync(recordPath(f, "scan-fault"), "utf8")).child_session_id, null);
  } finally { f.close(); }
});

test("child binding fails closed on a sibling json file with a noncanonical call hash name", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "wanted-bad-name", role: "executor-low", taskId: "task-1" }).ok, true);
    const records = path.join(f.root, ".opencode", "plans", ".state", "other-session", "dispatch-records");
    fs.mkdirSync(records, { recursive: true });
    fs.writeFileSync(path.join(records, "bad-name.json"), JSON.stringify({
      parent_session_id: "other-session", dispatch_call_id: "other-call", child_session_id: null,
      feature_id: "feat-scope", task_id: "task-1", role: "executor-low", scope_paths: ["src/a.ts"],
      allowed_writes: [], snapshot_hash: "a".repeat(64), claimed_at: "2026-08-01T00:00:00.000Z",
    }));
    const result = bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child-bad-name", role: "executor-low", callId: "wanted-bad-name" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /scan/i);
  } finally { f.close(); }
});

test("child binding fails closed when sibling file identity disagrees with its session directory", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "wanted-bad-parent", role: "executor-low", taskId: "task-1" }).ok, true);
    const records = path.join(f.root, ".opencode", "plans", ".state", "other-session", "dispatch-records");
    fs.mkdirSync(records, { recursive: true });
    const otherCall = "other-call";
    fs.writeFileSync(path.join(records, `${crypto.createHash("sha256").update(otherCall).digest("hex")}.json`), JSON.stringify({
      parent_session_id: "wrong-session", dispatch_call_id: otherCall, child_session_id: null,
      feature_id: "feat-scope", task_id: "task-1", role: "executor-low", scope_paths: ["src/a.ts"],
      allowed_writes: [], snapshot_hash: "a".repeat(64), claimed_at: "2026-08-01T00:00:00.000Z",
    }));
    const result = bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child-bad-parent", role: "executor-low", callId: "wanted-bad-parent" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /scan/i);
  } finally { f.close(); }
});

test("child binding rejects an internal symlink alias in the dispatch session scan", (t) => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "wanted-session-alias", role: "executor-low", taskId: "task-1" }).ok, true);
    const stateRoot = path.join(f.root, ".opencode", "plans", ".state");
    const realSession = path.join(stateRoot, "real-session");
    fs.mkdirSync(realSession, { recursive: true });
    try { fs.symlinkSync(realSession, path.join(stateRoot, "session-alias"), "dir"); } catch { t.skip("symlinks unavailable"); return; }
    const result = bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "child-session-alias", role: "executor-low", callId: "wanted-session-alias" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /scan/i);
  } finally { f.close(); }
});

test("internal symlink aliases normalize to one canonical scope path", (t) => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, "src"), { recursive: true });
    try { fs.symlinkSync(path.join(f.root, "src"), path.join(f.root, "src-alias"), "dir"); } catch { t.skip("symlinks unavailable"); return; }
    assert.deepEqual(normalizeProjectPath(f.root, "src-alias/a.ts"), { ok: true, path: "src/a.ts" });
  } finally { f.close(); }
});

test("scope keeps traversal, symlink escapes, and root aliases canonical", (t) => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, "src"));
    assert.equal(normalizeProjectPath(f.root, "src/../outside.ts").ok, false);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "scope-external-"));
    try { fs.symlinkSync(external, path.join(f.root, "escape"), "dir"); } catch { t.skip("symlinks unavailable"); }
    assert.equal(normalizeProjectPath(f.root, "escape/file.ts").ok, false);
    const alias = `${f.root}-alias`;
    fs.symlinkSync(f.root, alias, "dir");
    assert.deepEqual(normalizeProjectPath(alias, path.join(alias, "src", "a.ts")), { ok: true, path: "src/a.ts" });
    fs.unlinkSync(alias);
    fs.rmSync(external, { recursive: true, force: true });
  } finally { f.close(); }
});

test("dispatch records reject a symlinked state root and canonicalize a root alias", (t) => {
  const f = fixture();
  const external = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-external-"));
  try {
    const alias = `${f.root}-alias`;
    try {
      fs.symlinkSync(f.root, alias, "dir");
      assert.equal(claimActiveDispatch(alias, { sessionId: f.sessionId, callId: "alias", role: "executor-low", taskId: "task-1" }).ok, true);
      fs.cpSync(path.join(f.root, ".opencode"), path.join(external, ".opencode"), { recursive: true });
      fs.rmSync(path.join(f.root, ".opencode"), { recursive: true, force: true });
      fs.symlinkSync(path.join(external, ".opencode"), path.join(f.root, ".opencode"), "dir");
    } catch { t.skip("symlinks unavailable"); return; }
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "escape", role: "executor-low", taskId: "task-1" }).ok, false);
    fs.unlinkSync(alias);
  } finally {
    fs.rmSync(external, { recursive: true, force: true });
    f.close();
  }
});

test("canonical hand records derive frozen paths from the bound plan and narrow test-author writes", () => {
  const f = fixture([{
    id: "task-1", severity: "medium", complexity: "medium", scope_paths: ["src/", "tests/"], criterion_refs: ["#ac-1"],
    locked_tests: [{ id: "lt-1", path: "tests/a.test.mjs", fixture_paths: ["tests/fixtures/a.json"], assertion: "a" }],
  }]);
  try {
    const executor = claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "executor-frozen", role: "executor-low", taskId: "task-1" });
    assert.equal(executor.ok, true, executor.reason);
    assert.deepEqual(executor.claim.frozen_paths, ["tests/a.test.mjs", "tests/fixtures/a.json"]);

    const testAuthor = claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "test-author-frozen", role: "test-author", taskId: "task-1" });
    assert.equal(testAuthor.ok, true, testAuthor.reason);
    assert.deepEqual(testAuthor.claim.scope_paths, ["tests/a.test.mjs", "tests/fixtures/a.json"]);
    assert.deepEqual(testAuthor.claim.allowed_writes, []);
    assert.deepEqual(testAuthor.claim.frozen_paths, []);
  } finally { f.close(); }
});
