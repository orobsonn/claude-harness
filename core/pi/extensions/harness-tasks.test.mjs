import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import harnessTasks from "./harness-tasks.ts";
import { runNativeToolCall } from "./pi-native-tool.test.mjs";
import {
  MODEL_PROFILE_ENV,
  MODEL_PROFILE_HASH_ENV,
  resolveModelProfile,
  writeModelProfileSnapshot,
} from "../lib/model-profile.mjs";

test("native tool exposes sequential durable actions and derives the global identity from the host", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-tasks-tool-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = path.join(root, ".pi/harness/state/parent/gate-state.json");
  fs.mkdirSync(path.dirname(state), { recursive: true });
  fs.writeFileSync(
    state,
    JSON.stringify({
      session_id: "parent",
      feature_id: "feature",
      mode: "FULL",
      task_pipeline_version: 1,
    }),
  );
  let tool;
  harnessTasks({
    registerTool: (item) => {
      tool = item;
    },
    on: () => {},
  });
  assert.equal(tool.name, "harness_tasks");
  assert.equal(tool.executionMode, "sequential");
  const ctx = {
    cwd: root,
    sessionManager: { getSessionId: () => "parent", getHeader: () => ({}) },
  };
  const observed = await tool.execute(
    "call",
    { action: "status" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(observed.details.ok, true);
  assert.deepEqual(observed.details.tasks, []);
  const fake = await tool.execute(
    "fake",
    { action: "status", sessionId: "other" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(fake.isError, true);
  const child = {
    ...ctx,
    sessionManager: {
      ...ctx.sessionManager,
      getHeader: () => ({ parentSession: "global" }),
    },
  };
  assert.equal(
    (
      await tool.execute(
        "child",
        { action: "status" },
        undefined,
        undefined,
        child,
      )
    ).isError,
    true,
  );
});

function taskTool(injected) {
  let tool;
  const hooks = new Map();
  harnessTasks({
    registerTool: (item) => { tool = item; },
    on: (name, handler) => hooks.set(name, handler),
  }, injected);
  tool.testHooks = hooks;
  return tool;
}

const toolContext = {
  cwd: "/fixture/project",
  sessionManager: { getSessionId: () => "parent", getHeader: () => ({}) },
};

test("task dispatch exports the admitted profile pointers for an Orca local parent", async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-profile-tool-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stored = writeModelProfileSnapshot(root, "parent", resolveModelProfile({
    profile: "trial-orchestration-deepseek",
  }));
  const previousPath = process.env[MODEL_PROFILE_ENV];
  const previousHash = process.env[MODEL_PROFILE_HASH_ENV];
  process.env[MODEL_PROFILE_ENV] = stored.path;
  process.env[MODEL_PROFILE_HASH_ENV] = stored.sha256;
  t.after(() => {
    if (previousPath === undefined) delete process.env[MODEL_PROFILE_ENV];
    else process.env[MODEL_PROFILE_ENV] = previousPath;
    if (previousHash === undefined) delete process.env[MODEL_PROFILE_HASH_ENV];
    else process.env[MODEL_PROFILE_HASH_ENV] = previousHash;
  });
  let observed;
  const tool = taskTool({ executeAction: async (_params, context) => {
    observed = context;
    return { ok: true, tasks: [] };
  } });
  const result = await tool.execute("profile", { action: "status" }, undefined, undefined, {
    cwd: root,
    model: { provider: "ollama-cloud", id: "deepseek-v4.1-flash" },
    sessionManager: { getSessionId: () => "parent", getHeader: () => ({}) },
  });
  assert.equal(result.details.ok, true);
  assert.equal(observed.separateParentRouting, true);
  assert.deepEqual(observed.profileEnvironment, {
    [MODEL_PROFILE_ENV]: stored.path,
    [MODEL_PROFILE_HASH_ENV]: stored.sha256,
  });
});

test("abandon-resume exposes the explicit product judgment and passes only host-derived identity", async () => {
  const params = { action: "abandon-resume", task_id: "a", attempt_id: "attempt", expected_head: "a".repeat(40),
    no_product_obligation: true, reason: "Only the global delivery base required reconciliation." };
  const tool = taskTool({ executeAction: async (actual, context) => {
    assert.deepEqual(actual, params);
    assert.equal(context.projectRoot, toolContext.cwd);
    assert.equal(context.sessionId, "parent");
    return { ok: true, tasks: [] };
  } });
  assert.equal(tool.parameters.properties.action.anyOf.some((item) => item.const === "abandon-resume"), true);
  assert.equal(tool.parameters.properties.no_product_obligation.type, "boolean");
  const result = await tool.execute("abandon", params, undefined, undefined, toolContext);
  assert.equal(result.details.ok, true);
});

test("wait retries bounded Orca exit windows inside one tool call and revalidates status", async () => {
  let statusReads = 0;
  let waits = 0;
  const running = {
    ok: true,
    tasks: [{ task_id: "a", status: "running", launches: [{ run_id: "run-a", orca: { terminal_handle: "term-a" } }] }],
  };
  const tool = taskTool({
    executeAction: async (params) => {
      assert.deepEqual(params, { action: "status", task_id: "a" });
      statusReads++;
      return statusReads < 3 ? running : {
        ok: true,
        tasks: [{ ...running.tasks[0], status: "ready" }],
      };
    },
    waitOrca: async ({ terminalHandle, timeoutMs }) => {
      assert.equal(terminalHandle, "term-a");
      assert.equal(timeoutMs, 300_000);
      waits++;
      return { satisfied: waits === 2 };
    },
  });
  const result = await tool.execute(
    "wait",
    { action: "wait", task_id: "a" },
    undefined,
    undefined,
    toolContext,
  );
  assert.equal(result.details.wait.outcome, "changed");
  assert.equal(result.details.tasks[0].status, "ready");
  assert.equal(statusReads, 3);
  assert.equal(waits, 2);
});

test("wait races Orca handles, cancels losers, and treats exit only as a status wake", async () => {
  let statusReads = 0;
  let loserCancelled = false;
  const tool = taskTool({
    executeAction: async () => {
      statusReads++;
      const status = statusReads === 1 ? "running" : "blocked";
      return { ok: true, tasks: [
        { task_id: "a", status, launches: [{ run_id: "run-a", orca: { terminal_handle: "term-a" } }] },
        { task_id: "b", status: "running", launches: [{ run_id: "run-b", orca: { terminal_handle: "term-b" } }] },
      ] };
    },
    waitOrca: ({ terminalHandle, signal }) => terminalHandle === "term-a"
      ? Promise.resolve({ satisfied: true })
      : new Promise((resolve) => signal.addEventListener("abort", () => {
          loserCancelled = true;
          resolve({ satisfied: false });
        }, { once: true })),
  });
  const result = await tool.execute("wait", { action: "wait" }, undefined, undefined, toolContext);
  assert.equal(result.details.wait.outcome, "changed");
  assert.equal(result.details.tasks[0].status, "blocked");
  assert.equal(result.details.tasks[1].status, "running");
  assert.equal(loserCancelled, true);
});

test("wait observes legacy local jobs without Orca and abort never cancels the task", async () => {
  let statusReads = 0;
  let localWaits = 0;
  const tool = taskTool({
    executeAction: async () => {
      statusReads++;
      return { ok: true, tasks: [{
        task_id: "a",
        status: statusReads === 1 ? "running" : "ready",
        launches: [{ run_id: "run-a", pid: 123 }],
      }] };
    },
    delay: async () => { localWaits++; },
    waitOrca: async () => { throw new Error("must not use Orca for a local launch"); },
  });
  const completed = await tool.execute("wait", { action: "wait" }, undefined, undefined, toolContext);
  assert.equal(completed.details.wait.outcome, "changed");
  assert.equal(localWaits, 1);

  const controller = new AbortController();
  const aborting = taskTool({
    executeAction: async () => ({ ok: true, tasks: [{ task_id: "a", status: "running", launches: [{ run_id: "run-a", pid: 123 }] }] }),
    delay: async (_ms, signal) => {
      controller.abort();
      assert.equal(signal.aborted, true);
    },
  });
  const aborted = await aborting.execute("wait", { action: "wait" }, controller.signal, undefined, toolContext);
  assert.equal(aborted.details.wait.outcome, "aborted");
  assert.equal(aborted.details.tasks[0].status, "running");
});

test("wait rejects action fields that it would otherwise ignore", async () => {
  let statusReads = 0;
  const tool = taskTool({ executeAction: async () => { statusReads++; return { ok: true, tasks: [] }; } });
  const result = await tool.execute(
    "wait",
    { action: "wait", task_ids: ["a"] },
    undefined,
    undefined,
    toolContext,
  );
  assert.equal(result.isError, true);
  assert.match(result.details.reason, /task_ids is only valid for dispatch; use task_id for wait/);
  assert.equal(statusReads, 0);
  const boundedStatusOnly = await tool.execute(
    "wait-seconds",
    { action: "wait", wait_seconds: 1 },
    undefined,
    undefined,
    toolContext,
  );
  assert.equal(boundedStatusOnly.isError, true);
  assert.match(boundedStatusOnly.content[0].text, /only valid for status/);
  assert.equal(statusReads, 0);
});

test("status rejects plural task_ids before coordinator execution", async () => {
  let statusReads = 0;
  const tool = taskTool({ executeAction: async () => { statusReads++; return { ok: true, tasks: [] }; } });
  const result = await tool.execute(
    "status",
    { action: "status", task_ids: ["a"] },
    undefined,
    undefined,
    toolContext,
  );
  assert.equal(result.isError, true);
  assert.match(result.details.reason, /task_ids is only valid for dispatch; use task_id for status/);
  assert.equal(statusReads, 0);
});

test("task rejection reaches the model as a native Pi error with operation identity", async () => {
  const tool = taskTool({ executeAction: async () => ({ ok: true, tasks: [] }) });
  const { result } = await runNativeToolCall({
    tool,
    input: { action: "wait", wait_seconds: 1 },
    hooks: tool.testHooks,
    ctx: toolContext,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /harness-tasks:wait/i);
  assert.match(result.content[0].text, /only valid for status/i);
});

test("native task error preserves recovery identity and uncertain external effect fields", async () => {
  const failure = {
    ok: false,
    reason: "receipt timed out after dispatch",
    task_id: "task-a",
    attempt_id: "attempt-7",
    terminal_handle: "terminal-9",
    effect: "dispatch may already have started",
  };
  const tool = taskTool({ executeAction: async () => failure });
  const { result } = await runNativeToolCall({
    tool,
    input: { action: "dispatch", task_ids: ["task-a"], attempt_id: "attempt-7" },
    hooks: tool.testHooks,
    ctx: toolContext,
  });
  assert.equal(result.isError, true);
  assert.deepEqual(result.details, {
    ...failure,
    reason: "[harness-tasks:dispatch] receipt timed out after dispatch",
  });
  assert.deepEqual(JSON.parse(result.content[0].text), result.details);
});

test("a stale Orca handle falls back to status observation without deciding completion", async () => {
  let statusReads = 0;
  let localWaits = 0;
  const running = { ok: true, tasks: [{
    task_id: "a", status: "running",
    launches: [{ run_id: "run-a", orca: { terminal_handle: "term-stale" } }],
  }] };
  const tool = taskTool({
    executeAction: async () => {
      statusReads++;
      return statusReads < 3 ? running : { ok: true, tasks: [{ ...running.tasks[0], status: "ready" }] };
    },
    waitOrca: async () => { throw new Error("terminal_handle_stale"); },
    delay: async () => { localWaits++; },
  });
  const result = await tool.execute("wait", { action: "wait" }, undefined, undefined, toolContext);
  assert.equal(result.details.wait.outcome, "changed");
  assert.equal(statusReads, 3);
  assert.equal(localWaits, 1, "the stale handle is not re-armed in a busy loop");
});

test("a running task without a usable handle keeps mixed Orca waits on the local observation cadence", async () => {
  let statusReads = 0;
  let localWaits = 0;
  let orcaCancelled = false;
  const tool = taskTool({
    executeAction: async () => {
      statusReads++;
      const aStatus = statusReads === 1 ? "running" : "ready";
      return { ok: true, tasks: [
        { task_id: "a", status: aStatus, launches: [{ run_id: "local-a", pid: 1 }] },
        { task_id: "b", status: "running", launches: [{ run_id: "orca-b", orca: { terminal_handle: "term-b" } }] },
      ] };
    },
    delay: async (_ms, signal) => {
      localWaits++;
      assert.equal(signal.aborted, false);
    },
    waitOrca: (_input) => new Promise((resolve) => _input.signal.addEventListener("abort", () => {
      orcaCancelled = true;
      resolve({ satisfied: false });
    }, { once: true })),
  });
  const result = await tool.execute("wait", { action: "wait" }, undefined, undefined, toolContext);
  assert.equal(result.details.wait.outcome, "changed");
  assert.equal(localWaits, 1);
  assert.equal(orcaCancelled, true);
});
