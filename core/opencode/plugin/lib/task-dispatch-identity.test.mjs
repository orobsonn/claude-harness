/** @description Strict delimiter and JSON tests for official Task prompt identity + task tool identity. */

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTaskDispatchIdentity,
  isTaskTool,
  extractSubagentType,
} from "./task-dispatch-identity.mjs";

const OPEN = "[HARNESS_TASK_CONTEXT]";
const CLOSE = "[/HARNESS_TASK_CONTEXT]";
const JSON_BODY = '{"task_id":"task-1"}';

test("task marker accepts exactly one ordered complete block", () => {
  assert.deepEqual(parseTaskDispatchIdentity(`Before\n${OPEN}${JSON_BODY}${CLOSE}\nAfter`), { ok: true, taskId: "task-1" });
});

test("task marker rejects extra closes before or after the valid block", () => {
  for (const prompt of [
    `${CLOSE}${OPEN}${JSON_BODY}${CLOSE}`,
    `${OPEN}${JSON_BODY}${CLOSE}${CLOSE}`,
  ]) assert.equal(parseTaskDispatchIdentity(prompt).ok, false);
});

test("task marker rejects duplicate, nested, reversed, and trailing markers", () => {
  for (const prompt of [
    `${OPEN}${JSON_BODY}${CLOSE}${OPEN}${JSON_BODY}${CLOSE}`,
    `${OPEN}${OPEN}${JSON_BODY}${CLOSE}${CLOSE}`,
    `${CLOSE}${JSON_BODY}${OPEN}`,
    `${OPEN}${JSON_BODY}${CLOSE}${OPEN}`,
    `${OPEN}${JSON_BODY}${CLOSE} trailing ${CLOSE}`,
  ]) assert.equal(parseTaskDispatchIdentity(prompt).ok, false);
});

test("task marker rejects malformed JSON and non-exact payload shape", () => {
  for (const body of [
    '{"task_id":',
    '{"task_id":"task-1","task_id":"task-2"}',
    '{"task_id":"task-1","feature_id":"foreign"}',
    '{"task_id":"bad task"}',
  ]) assert.equal(parseTaskDispatchIdentity(`${OPEN}${body}${CLOSE}`).ok, false);
});

test("extractSubagentType and isTaskTool parse OC task args including nested input", () => {
  assert.equal(isTaskTool("task"), true);
  assert.equal(isTaskTool("agent"), true);
  assert.equal(isTaskTool("foo.task"), true);
  assert.equal(isTaskTool("foo.agent"), true);
  assert.equal(isTaskTool("Task"), true);
  assert.equal(isTaskTool("bash"), false);
  assert.equal(isTaskTool("my_task"), false);
  assert.equal(
    extractSubagentType({ subagent_type: "executor-high" }),
    "executor-high",
  );
  assert.equal(
    extractSubagentType({ input: { subagent_type: "sniper-low" } }),
    "sniper-low",
  );
  assert.equal(
    extractSubagentType({ subagent: "executor-medium" }),
    "executor-medium",
  );
  // Official Task `command` is resume/host field — never harness role.
  assert.equal(extractSubagentType({ command: "executor-high" }), "");
  assert.equal(
    extractSubagentType({
      subagent_type: "plan-reviewer-family-1",
      command: "resume-or-skill-command",
      task_id: "official-resume-id",
    }),
    "plan-reviewer-family-1",
  );
});
