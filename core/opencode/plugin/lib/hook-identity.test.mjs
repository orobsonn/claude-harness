/** @description Trust-tier and alias-conflict tests for OpenCode hook identity. */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveHookIdentity, extractHookTaskContext } from "./hook-identity.mjs";

test("conflicting untrusted task aliases resolve tolerantly to the first alias in priority order (#484)", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a" },
    toolArgs: { task: "task-a", taskId: "task-b" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "task-b");
  assert.equal(result.taskIdSource, "tool-input");
});

test("untrusted taskId dispatch args diverging from the brief's HARNESS_TASK_CONTEXT marker fail closed (#484 adversary finding)", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a" },
    toolArgs: { taskId: "task-2" },
    promptTaskId: "task-5",
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /taskId dispatch args diverge from the brief.*task-2.*task-5/);
});

test("trusted platform task identity overrides one consistent untrusted identity", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a", task_id: "trusted-task" },
    toolArgs: { taskId: "model-task" },
    promptTaskId: "model-task",
  });
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "trusted-task");
  assert.equal(result.taskIdSource, "runtime-envelope");
});

test("trusted aliases resolve tolerantly to the first alias when the runtime envelope disagrees with itself (#484)", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a", sessionId: "ses-b" },
    toolArgs: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, "ses-a");
  assert.equal(result.sessionIdSource, "runtime-envelope");
});

test("official Task command/task_id are not harness role or plan-task", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a" },
    toolArgs: {
      subagent_type: "plan-reviewer-family-1",
      command: "resume-or-skill-command",
      task_id: "official-resume-id",
    },
    promptTaskId: "task-1",
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.role, "plan-reviewer-family-1");
  assert.equal(result.roleSource, "tool-input");
  assert.equal(result.taskId, "task-1");
  assert.equal(result.taskIdSource, "tool-input");
});

test("role without subagent_type ignores bare command field", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a" },
    toolArgs: { command: "not-a-role" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.role, "");
  assert.equal(result.roleSource, "missing");
});

test("official Task.task_id alone does not become plan task without HARNESS_TASK_CONTEXT", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a" },
    toolArgs: { task_id: "official-resume-id" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.taskId, "");
  assert.equal(result.taskIdSource, "missing");
});

// ---- extractHookTaskContext (OC hook shape: input.tool + output.args) ----

test("extractHookTaskContext({tool:'task',sessionID:'ses_x'},{args:{subagent_type:'executor-low'}}) returns toolName, subagentType, sessionId", () => {
  const ctx = extractHookTaskContext(
    { tool: "task", sessionID: "ses_x" },
    { args: { subagent_type: "executor-low" } },
  );
  assert.equal(ctx.toolName, "task");
  assert.equal(ctx.subagentType, "executor-low");
  assert.equal(ctx.sessionId, "ses_x");
  assert.deepEqual(ctx.toolArgs, { subagent_type: "executor-low" });
});

test("extractHookTaskContext belt-reads input.args when output.args missing", () => {
  const ctx1 = extractHookTaskContext(
    { tool: "task", args: { subagent_type: "executor-low" } },
    {},
  );
  assert.equal(ctx1.subagentType, "executor-low");
  assert.equal(ctx1.toolName, "task");

  const ctx2 = extractHookTaskContext(
    { tool: "task", args: { subagent_type: "adversary" } },
    null,
  );
  assert.equal(ctx2.subagentType, "adversary");

  const ctx3 = extractHookTaskContext({ tool: "task" }, {});
  assert.equal(ctx3.subagentType, "");
});

test("lt-extract-hook-sessionid-alias — extractHookTaskContext accepts sessionId camelCase AND sessionID; toolArgs.session_id alone does NOT set sessionId from extractHookTaskContext", () => {
  const ctxUpper = extractHookTaskContext(
    { tool: "task", sessionID: "ses_upperID" },
    { args: { subagent_type: "executor-low" } },
  );
  assert.equal(ctxUpper.sessionId, "ses_upperID");

  const ctxCamel = extractHookTaskContext(
    { tool: "task", sessionId: "ses_camelId" },
    { args: { subagent_type: "executor-low" } },
  );
  assert.equal(ctxCamel.sessionId, "ses_camelId");

  // toolArgs must never populate sessionId in this extractor (hook input only)
  const ctxArgs = extractHookTaskContext(
    { tool: "task" },
    { args: { session_id: "ses_fromToolArgsOnly" } },
  );
  assert.equal(ctxArgs.sessionId, null);
  assert.equal(ctxArgs.toolName, "task");
});
