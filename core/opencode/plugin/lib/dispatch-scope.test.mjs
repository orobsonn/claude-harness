/** @description Focused authority, CAS, path-hardening, composition, and shell-target tests. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendScopeEvent,
  bindChildSession,
  claimActiveDispatch,
  clearActiveDispatch,
  finishActiveDispatch,
  hasCleanupPending,
  heartbeatActiveDispatch,
  normalizeProjectPath,
  reconcileExpiredDispatch,
} from "./dispatch-scope.mjs";
import { semanticPlanHash } from "./planner-artifact.mjs";
import { scopeRuntimeCompositionMode } from "./scope-runtime-composition.mjs";
import { createPlanGateHooks } from "../plan-gate.ts";
import { createObsHandHooks } from "../obs-hand.ts";
import { createPlanWriteGateHooks } from "../plan-write-gate.ts";
import { resolveScopeRuntimeIdentity } from "./scope-runtime-identity.mjs";

function fixture(scopePaths = ["src/a.ts"]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-scope-"));
  const sessionId = "ses-scope";
  const featureId = "feat-scope";
  const plan = {
    feature_id: featureId,
    kind: "full",
    mode: "full",
    tasks: [{
      id: "task-1",
      severity: "medium",
      complexity: "medium",
      scope_paths: scopePaths,
      criterion_refs: ["#ac-1"],
      locked_tests: [{ id: "lt-1", path: "tests/foo.test.mjs" }],
    }],
  };
  const hash = semanticPlanHash(plan);
  const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
  const relativeSnapshot = `.opencode/plans/.state/${sessionId}/bound-plans/${hash}.json`;
  fs.mkdirSync(path.join(stateDir, "bound-plans"), { recursive: true });
  fs.writeFileSync(path.join(root, relativeSnapshot), JSON.stringify(plan));
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: sessionId,
    feature_id: featureId,
    planner_status: "usable",
    delivery_status: "ready",
    planner_plan_binding: { session_id: sessionId, feature_id: featureId, snapshot_path: relativeSnapshot, snapshot_hash: hash },
  }));
  return {
    root,
    sessionId,
    statePath: path.join(stateDir, "gate-state.json"),
    read: () => JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8")),
    close: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function officialMessages(sessionId, calls, agent = "executor-high") {
  const list = Array.isArray(calls) ? calls : [calls];
  return [
    { info: { id: "user", sessionID: sessionId, role: "user", agent }, parts: [] },
    ...list.map(({ callID, tool = "write" }, index) => ({
      info: { id: `assistant-${index}`, sessionID: sessionId, role: "assistant", parentID: "user", mode: agent },
      parts: [{ id: `part-${index}`, sessionID: sessionId, messageID: `assistant-${index}`, type: "tool", callID, tool, state: { status: "running", input: {}, time: { start: 1 } } }],
    })),
  ];
}

test("claim is atomic, snapshot-derived, and matching cleanup handles success or failure", () => {
  const f = fixture();
  try {
    const claim = claimActiveDispatch(f.root, {
      sessionId: f.sessionId,
      callId: "call-1",
      role: "executor-high",
      taskId: "task-1",
      token: "token-1",
      now: 1_000,
    });
    assert.equal(claim.ok, true);
    assert.deepEqual(claim.claim.scope_paths, ["src/a.ts"]);
    assert.equal(claim.claim.session_id, f.sessionId);
    assert.equal(claim.claim.feature_id, "feat-scope");
    assert.equal(claim.claim.task_id, "task-1");
    assert.equal(clearActiveDispatch(f.root, { sessionId: f.sessionId, callId: "call-1", token: "wrong" }).cleared, false);
    assert.equal(f.read().active_dispatch.claim_token, "token-1");
    assert.equal(clearActiveDispatch(f.root, { sessionId: f.sessionId, callId: "call-1", token: "token-1" }).cleared, true);
    assert.equal(f.read().active_dispatch, undefined);
  } finally { f.close(); }
});

test("concurrent/replayed claims cannot replace a live dispatch or clear a newer claim", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "old", role: "executor-low", taskId: "task-1", token: "old-token", now: 1_000 }).ok, true);
    const competing = claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "new", role: "executor-low", taskId: "task-1", token: "new-token", now: 2_000 });
    assert.equal(competing.ok, false);
    assert.match(competing.reason, /another/);
    assert.equal(clearActiveDispatch(f.root, { sessionId: f.sessionId, callId: "new", token: "new-token" }).cleared, false);
    assert.equal(f.read().active_dispatch.call_id, "old");
  } finally { f.close(); }
});

test("restart reconciliation marks expired authority stale and never deletes without termination proof", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "old", role: "executor", taskId: "task-1", token: "old-token", now: 1_000 }).ok, true);
    assert.equal(reconcileExpiredDispatch(f.root, f.sessionId, 2_000).stale, false);
    assert.equal(reconcileExpiredDispatch(f.root, f.sessionId, 31 * 60 * 1000).stale, true);
    assert.equal(f.read().active_dispatch.status, "stale");
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "new", role: "executor", taskId: "task-1", token: "new-token", now: 31 * 60 * 1000 }).ok, false);
    assert.equal(clearActiveDispatch(f.root, { sessionId: f.sessionId, callId: "old", token: "old-token" }).cleared, true);
    assert.equal(f.read().active_dispatch, undefined);
  } finally { f.close(); }
});

test("scope rejects traversal, external absolute paths, and symlink escape", (t) => {
  const f = fixture();
  try {
    fs.mkdirSync(path.join(f.root, "src"), { recursive: true });
    assert.equal(normalizeProjectPath(f.root, "src/../outside.ts").ok, false);
    assert.equal(normalizeProjectPath(f.root, path.join(os.tmpdir(), "outside.ts")).ok, false);
    const external = fs.mkdtempSync(path.join(os.tmpdir(), "scope-external-"));
    try {
      try { fs.symlinkSync(external, path.join(f.root, "escape"), "dir"); } catch { t.skip("symlinks unavailable"); }
      assert.equal(normalizeProjectPath(f.root, "escape/file.ts").ok, false);
    } finally { fs.rmSync(external, { recursive: true, force: true }); }
  } finally { f.close(); }
});

test("composition proof requires all three real plugin factories in this process", async () => {
  const f = fixture();
  try {
    assert.equal(scopeRuntimeCompositionMode(f.root), "shadow");
    fs.mkdirSync(path.join(f.root, ".opencode", "plugin"), { recursive: true });
    for (const file of ["obs-hand.ts", "plan-write-gate.ts", "plan-gate.ts"]) fs.writeFileSync(path.join(f.root, ".opencode", "plugin", file), "");
    fs.writeFileSync(path.join(f.root, "opencode.json"), JSON.stringify({ plugin: ["./.opencode/plugin/plan-gate.ts", "./.opencode/plugin/plan-write-gate.ts", "./.opencode/plugin/obs-hand.ts"] }));
    assert.equal(scopeRuntimeCompositionMode(f.root), "shadow", "empty files/config cannot prove runtime composition");
    await createPlanGateHooks(f.root);
    await createObsHandHooks(f.root);
    assert.equal(scopeRuntimeCompositionMode(f.root), "shadow");
    await createPlanWriteGateHooks(f.root);
    assert.equal(scopeRuntimeCompositionMode(f.root), "enforce");
  } finally { f.close(); }
});

test("durable event is sanitized", () => {
  const f = fixture();
  try {
    const claim = claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "secret-call", role: "executor", taskId: "task-1", token: "secret-token" });
    assert.equal(claim.ok, true);
    assert.equal(appendScopeEvent(f.root, claim.claim, { tool: "bash", paths: ["outside/b.ts"], mode: "shadow", reason: "outside-approved-scope" }).ok, true);
    const raw = fs.readFileSync(path.join(f.root, ".opencode", "plans", ".state", f.sessionId, "scope-events.jsonl"), "utf8");
    assert.match(raw, /hand-scope-rejection/);
    assert.match(raw, /outside\/b\.ts/);
    assert.doesNotMatch(raw, /secret-call|secret-token/);
  } finally { f.close(); }
});

test("bounded cleanup failure persists fail-closed cleanup_pending", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "call-fail", role: "executor", taskId: "task-1", token: "token-fail" }).ok, true);
    let attempts = 0;
    const finished = finishActiveDispatch(f.root, {
      sessionId: f.sessionId,
      callId: "call-fail",
      token: "token-fail",
    }, {
      attempts: 3,
      clearFn: () => { attempts += 1; return { ok: false, reason: "lock busy" }; },
    });
    assert.equal(finished.ok, false);
    assert.equal(attempts, 3);
    assert.equal(hasCleanupPending(f.root, f.sessionId), true);
    assert.equal(f.read().active_dispatch.call_id, "call-fail");
  } finally { f.close(); }
});

test("heartbeat extends only before expiry and never revives an expired claim", () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "long", role: "executor-high", taskId: "task-1", token: "long-token", now: 1_000 }).ok, true);
    const heartbeat = heartbeatActiveDispatch(f.root, { sessionId: f.sessionId, callId: "long", role: "executor-low", now: 29 * 60 * 1000 });
    assert.equal(heartbeat.ok, true);
    assert.equal(reconcileExpiredDispatch(f.root, f.sessionId, 31 * 60 * 1000).stale, false);
    assert.equal(f.read().active_dispatch.status, "active");
    const expired = heartbeatActiveDispatch(f.root, { sessionId: f.sessionId, callId: "long", role: "executor-low", now: 60 * 60 * 1000 });
    assert.equal(expired.ok, false);
    assert.equal(f.read().active_dispatch.status, "stale");
  } finally { f.close(); }
});

test("claim rejects non-usable planner and delivery-blocked state", () => {
  for (const patch of [{ planner_status: "plan_invalid" }, { delivery_status: "delivery-blocked" }]) {
    const f = fixture();
    try {
      fs.writeFileSync(f.statePath, JSON.stringify({ ...f.read(), ...patch }));
      const claim = claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "blocked", role: "executor", taskId: "task-1", token: "blocked-token" });
      assert.equal(claim.ok, false);
    } finally { f.close(); }
  }
});

test("official SDK session/message shape binds child and resolves role without input.agent", async () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "sdk-call", role: "executor-high", taskId: "task-1", token: "sdk-token" }).ok, true);
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-child", role: "executor-high" }).ok, true);
    const reader = {
      getSession: async (id) => ({ id, parentID: f.sessionId }),
      getMessages: async () => officialMessages("ses-child", { callID: "write-call" }),
    };
    const identity = await resolveScopeRuntimeIdentity(f.root, { tool: "write", sessionID: "ses-child", callID: "write-call" }, { reader });
    assert.equal(identity.ok, true);
    assert.equal(identity.parentSessionId, f.sessionId);
    assert.equal(identity.role, "executor-high");
    const crossParent = await resolveScopeRuntimeIdentity(f.root, { tool: "write", sessionID: "ses-foreign", callID: "foreign-call" }, {
      reader: { ...reader, getSession: async (id) => ({ id, parentID: "ses-other-parent" }) },
    });
    assert.equal(crossParent.ok, false);
  } finally { f.close(); }
});

test("official client smoke gates child writes through parent active_dispatch", async () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "smoke-call", role: "executor-high", taskId: "task-1", token: "smoke-token" }).ok, true);
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-smoke-child", role: "executor-high" }).ok, true);
    let messageReads = 0;
    const client = { session: {
      get: async ({ path: sdkPath }) => ({ data: { id: sdkPath.id, parentID: f.sessionId } }),
      messages: async () => {
        messageReads += 1;
        return { data: officialMessages("ses-smoke-child", [
          { callID: "write-in" },
          { callID: "write-out" },
          { callID: "write-shadow" },
        ]) };
      },
    } };
    await createPlanGateHooks(f.root);
    await createObsHandHooks(f.root, { client });
    const hooks = await createPlanWriteGateHooks(f.root, { client });
    const before = hooks["tool.execute.before"];
    await assert.doesNotReject(() => before(
      { tool: "write", sessionID: "ses-smoke-child", callID: "write-in" },
      { args: { filePath: "src/a.ts", content: "x" } },
    ));
    assert.equal(messageReads, 1);
    await hooks["tool.execute.after"]({ tool: "write", sessionID: "ses-smoke-child", callID: "write-in" }, {});
    await assert.doesNotReject(() => before(
      { tool: "write", sessionID: "ses-smoke-child", callID: "write-in" },
      { args: { filePath: "src/a.ts", content: "x" } },
    ));
    assert.equal(messageReads, 2, "terminal after invalidates sessionID+callID cache");
    await assert.rejects(() => before(
      { tool: "write", sessionID: "ses-smoke-child", callID: "write-out" },
      { args: { filePath: "outside.ts", content: "x" } },
    ), /OUTSIDE/);
  } finally { f.close(); }
});

test("official client shadow records out-of-scope child write without messageID", async () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "shadow-parent-call", role: "executor-high", taskId: "task-1", token: "shadow-parent-token" }).ok, true);
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-shadow-child", role: "executor-high" }).ok, true);
    const client = { session: {
      get: async ({ path: sdkPath }) => ({ data: { id: sdkPath.id, parentID: f.sessionId } }),
      messages: async () => ({ data: officialMessages("ses-shadow-child", { callID: "shadow-write" }) }),
    } };
    const before = (await createPlanWriteGateHooks(f.root, { client }))["tool.execute.before"];
    await assert.doesNotReject(() => before(
      { tool: "write", sessionID: "ses-shadow-child", callID: "shadow-write" },
      { args: { filePath: "outside.ts", content: "x" } },
    ));
    assert.match(fs.readFileSync(path.join(f.root, ".opencode", "plans", ".state", f.sessionId, "scope-events.jsonl"), "utf8"), /outside\.ts/);
  } finally { f.close(); }
});

test("official call lookup fails closed on zero or multiple matching tool parts", async () => {
  for (const [label, messages] of [
    ["zero", officialMessages("ses-lookup", { callID: "different" })],
    ["multiple", officialMessages("ses-lookup", [{ callID: "duplicate" }, { callID: "duplicate" }])],
  ]) {
    const f = fixture();
    try {
      assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: `parent-${label}`, role: "executor-high", taskId: "task-1", token: `token-${label}` }).ok, true);
      assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-lookup", role: "executor-high" }).ok, true);
      const identity = await resolveScopeRuntimeIdentity(f.root, { tool: "write", sessionID: "ses-lookup", callID: label === "zero" ? "missing" : "duplicate" }, {
        reader: { getSession: async (id) => ({ id, parentID: f.sessionId }), getMessages: async () => messages },
      });
      assert.equal(identity.ok, false, label);
      assert.match(identity.reason, /exactly one/);
    } finally { f.close(); }
  }
});

test("CLI primary session uses capability binding and canonical test-author-spawn role", async () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "cli-call", role: "test-author", taskId: "task-1", token: "cli-token" }).ok, true);
    const reader = {
      getSession: async (id) => ({ id }),
      getMessages: async () => officialMessages("ses-cli", { callID: "cli-write" }, "test-author-spawn"),
    };
    const identity = await resolveScopeRuntimeIdentity(f.root, { tool: "write", sessionID: "ses-cli", callID: "cli-write" }, {
      reader,
      adapterParentSessionId: f.sessionId,
      adapterToken: "cli-token",
    });
    assert.equal(identity.ok, true);
    assert.equal(identity.adapter, true);
    assert.equal(identity.role, "test-author-spawn");
  } finally { f.close(); }
});
