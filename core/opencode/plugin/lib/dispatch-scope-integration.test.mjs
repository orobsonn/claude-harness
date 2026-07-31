/** @description Integration contracts requiring live OpenCode plugin factories. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindChildSession, claimActiveDispatch } from "../../lib/dispatch-scope.mjs";
import { semanticPlanHash } from "../../lib/planner-artifact.mjs";
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
      locked_tests: [{ id: "lt-1", path: "tests/foo.test.mjs", assertion: "Given foo, When run, Then ok" }],
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
