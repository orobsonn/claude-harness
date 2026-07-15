/** @description Trust-tier and alias-conflict tests for OpenCode hook identity. */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveHookIdentity } from "./hook-identity.mjs";

test("conflicting untrusted task aliases fail closed and report values", () => {
  const result = resolveHookIdentity({
    input: { sessionID: "ses-a" },
    toolArgs: { task_id: "task-a", taskId: "task-b" },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /taskId.*conflict.*task-a.*task-b/);
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
