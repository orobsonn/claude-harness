/** @description Integration contracts requiring live OpenCode plugin factories. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindChildSession, claimActiveDispatch } from "../../lib/dispatch-scope.mjs";
import { semanticPlanHash } from "../../lib/planner-artifact.mjs";
import { createPlanGateHooks } from "../plan-gate.ts";
import { createObsHandHooks } from "../obs-hand.ts";
import { createPlanWriteGateHooks } from "../plan-write-gate.ts";
import { resolveScopeRuntimeIdentity } from "./scope-runtime-identity.mjs";

function fixture(scopePaths = ["src/a.ts"], tasks = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-scope-"));
  const sessionId = "ses-scope";
  const featureId = "feat-scope";
  const plan = {
    feature_id: featureId,
    kind: "full",
    mode: "full",
    tasks: tasks ?? [{
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
test("scope plugins load independently without a process-global composition registry", async () => {
  const f = fixture();
  try {
    assert.ok(await createPlanGateHooks(f.root));
    assert.ok(await createObsHandHooks(f.root));
    assert.ok(await createPlanWriteGateHooks(f.root));
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

test("sibling writing children bind to their factual parent Task calls and keep scopes isolated", async () => {
  const f = fixture(undefined, [
    { id: "task-left", severity: "medium", complexity: "medium", scope_paths: ["src/left.ts"], criterion_refs: ["#ac-left"], locked_tests: [{ id: "lt-left", path: "tests/left.test.mjs", assertion: "left" }] },
    { id: "task-right", severity: "medium", complexity: "medium", scope_paths: ["src/right.ts"], criterion_refs: ["#ac-right"], locked_tests: [{ id: "lt-right", path: "tests/right.test.mjs", assertion: "right" }] },
  ]);
  try {
    const parentParts = [
      { callID: "call-left", child: "child-left", taskId: "task-left" },
      { callID: "call-right", child: "child-right", taskId: "task-right" },
    ];
    const client = { session: {
      get: async ({ path: sdkPath }) => ({ data: { id: sdkPath.id, parentID: f.sessionId } }),
      messages: async ({ path: sdkPath }) => ({ data: sdkPath.id === f.sessionId
        ? parentParts.map(({ callID, child }, index) => ({
          info: { id: `parent-assistant-${index}`, sessionID: f.sessionId, role: "assistant", parentID: `parent-user-${index}`, agent: "build" },
          parts: [
            { id: `historic-part-${index}`, sessionID: f.sessionId, messageID: `parent-assistant-${index}`, type: "tool", callID: `historic-${callID}`, tool: "task", state: { status: "completed", input: { subagent_type: "executor-medium" }, metadata: { sessionId: child } } },
            { id: `parent-part-${index}`, sessionID: f.sessionId, messageID: `parent-assistant-${index}`, type: "tool", callID, tool: "task", state: { status: "running", input: { subagent_type: "executor-medium" }, metadata: { sessionId: child } } },
          ],
        }))
        : officialMessages(sdkPath.id, { callID: `write-${sdkPath.id}` }, "executor-medium") }),
    } };
    const obs = await createObsHandHooks(f.root, { client });
    const writes = await createPlanWriteGateHooks(f.root, { client });
    for (const { callID, taskId } of parentParts) {
      await obs["tool.execute.before"]({ tool: "task", sessionID: f.sessionId, callID }, { args: { prompt: `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]`, subagent_type: "executor-medium" } });
    }
    for (const { child } of parentParts) {
      await obs.event({ event: { type: "message.updated", properties: { info: { sessionID: child, role: "user", agent: "executor-medium" } } } });
    }
    await assert.doesNotReject(() => writes["tool.execute.before"]({ tool: "write", sessionID: "child-left", callID: "write-child-left" }, { args: { filePath: "src/left.ts", content: "left" } }));
    await assert.doesNotReject(() => writes["tool.execute.before"]({ tool: "write", sessionID: "child-right", callID: "write-child-right" }, { args: { filePath: "src/right.ts", content: "right" } }));
    await assert.rejects(() => writes["tool.execute.before"]({ tool: "write", sessionID: "child-left", callID: "write-child-left" }, { args: { filePath: "src/right.ts", content: "cross" } }), /OUTSIDE/);
    await obs.event({ event: { type: "session.idle", properties: { sessionID: "child-left" } } });
    await assert.doesNotReject(() => writes["tool.execute.before"]({ tool: "write", sessionID: "child-right", callID: "write-child-right" }, { args: { filePath: "src/right.ts", content: "right-again" } }));
  } finally { f.close(); }
});

test("official client smoke gates child writes through the exact parent dispatch record", async () => {
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

test("official client denies an out-of-scope child write without a composition registry", async () => {
  const f = fixture();
  try {
    assert.equal(claimActiveDispatch(f.root, { sessionId: f.sessionId, callId: "shadow-parent-call", role: "executor-high", taskId: "task-1", token: "shadow-parent-token" }).ok, true);
    assert.equal(bindChildSession(f.root, { parentSessionId: f.sessionId, childSessionId: "ses-shadow-child", role: "executor-high" }).ok, true);
    const client = { session: {
      get: async ({ path: sdkPath }) => ({ data: { id: sdkPath.id, parentID: f.sessionId } }),
      messages: async () => ({ data: officialMessages("ses-shadow-child", { callID: "shadow-write" }) }),
    } };
    const before = (await createPlanWriteGateHooks(f.root, { client }))["tool.execute.before"];
    await assert.rejects(() => before(
      { tool: "write", sessionID: "ses-shadow-child", callID: "shadow-write" },
      { args: { filePath: "outside.ts", content: "x" } },
    ), /OUTSIDE/);
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
