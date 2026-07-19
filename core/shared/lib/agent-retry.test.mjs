/** @description Locked tests for unified agent retry K=3. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_RETRY_K,
  agentRetryKey,
  applyAgentDispatchOutcome,
  decideAgentRetryAllowed,
} from "./agent-retry.mjs";

test("AGENT_RETRY_K is 3", () => {
  assert.equal(AGENT_RETRY_K, 3);
});

test("key with and without taskId", () => {
  assert.equal(agentRetryKey("planner"), "planner");
  assert.equal(agentRetryKey("executor-high", "t1"), "executor-high::t1");
});

test("three failures exhaust; success resets", () => {
  let state = {};
  for (let i = 1; i <= 3; i++) {
    const r = applyAgentDispatchOutcome(state, { role: "planner", outcome: "failure" });
    state = r.state;
    assert.equal(r.failures, i);
    assert.equal(r.exhausted, i >= 3);
  }
  assert.equal(decideAgentRetryAllowed(state, { role: "planner" }).ok, false);
  const ok = applyAgentDispatchOutcome(state, { role: "planner", outcome: "success" });
  assert.equal(ok.failures, 0);
  assert.equal(decideAgentRetryAllowed(ok.state, { role: "planner" }).ok, true);
});

test("task-scoped keys are independent", () => {
  let state = {};
  state = applyAgentDispatchOutcome(state, { role: "executor-high", taskId: "t1", outcome: "failure" }).state;
  state = applyAgentDispatchOutcome(state, { role: "executor-high", taskId: "t1", outcome: "failure" }).state;
  state = applyAgentDispatchOutcome(state, { role: "executor-high", taskId: "t1", outcome: "failure" }).state;
  assert.equal(decideAgentRetryAllowed(state, { role: "executor-high", taskId: "t1" }).ok, false);
  assert.equal(decideAgentRetryAllowed(state, { role: "executor-high", taskId: "t2" }).ok, true);
});
