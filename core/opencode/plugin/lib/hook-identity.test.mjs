/** @description Trust-tier and alias-conflict tests for OpenCode hook identity. */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveHookIdentity } from "./hook-identity.mjs";

test("conflicting untrusted task aliases fail closed and report values", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a" },
    toolArgs: { task: "task-a", taskId: "task-b" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /taskId.*conflict.*task-[ab].*task-[ab]/);
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

test("trusted aliases also fail closed when the runtime envelope conflicts with itself", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a", sessionId: "ses-b" },
    toolArgs: {},
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /sessionId.*conflict/);
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
