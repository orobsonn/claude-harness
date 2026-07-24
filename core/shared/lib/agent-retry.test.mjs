/** @description Locked tests for unified agent retry K=3. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_RETRY_K,
  GATE_BLOCKED_DISPATCH_K,
  agentRetryKey,
  applyAgentDispatchOutcome,
  applyGateBlockedDispatch,
  decideAgentRetryAllowed,
  decideGateBlockedDispatchAllowed,
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

test("success clears the stale last_failure pointing at the same key", () => {
  let state = applyAgentDispatchOutcome({}, { role: "planner", outcome: "failure" }).state;
  assert.equal(state.agent_dispatch_last_failure.key, "planner");
  state = applyAgentDispatchOutcome(state, { role: "planner", outcome: "success" }).state;
  assert.equal(state.agent_dispatch_last_failure, null);
});

test("success does not clear a last_failure belonging to another key", () => {
  let state = applyAgentDispatchOutcome({}, { role: "planner", outcome: "failure" }).state;
  state = applyAgentDispatchOutcome(state, { role: "compliance", outcome: "success" }).state;
  assert.equal(state.agent_dispatch_last_failure.key, "planner");
});

test("harness-gate denials are bounded in their own namespace, never the agent budget", () => {
  let state = {};
  for (let i = 1; i <= GATE_BLOCKED_DISPATCH_K; i++) {
    const r = applyGateBlockedDispatch(state, {
      role: "plan-reviewer-family-2",
      reason: "[plan-gate] delivery-blocked: planner usable bound artifact required",
    });
    state = r.state;
    assert.equal(r.blocked, i);
    assert.equal(r.exhausted, i >= GATE_BLOCKED_DISPATCH_K);
  }
  // The denied agent never ran: its own retry budget must be untouched.
  assert.deepEqual(state.agent_dispatch_failures, undefined);
  assert.equal(decideAgentRetryAllowed(state, { role: "plan-reviewer-family-2" }).ok, true);
  // But the dispatcher still stops instead of re-dispatching forever.
  const bound = decideGateBlockedDispatchAllowed(state, { role: "plan-reviewer-family-2" });
  assert.equal(bound.ok, false);
  assert.match(bound.reason, /precondition/);
});

test("task-scoped keys are independent", () => {
  let state = {};
  state = applyAgentDispatchOutcome(state, { role: "executor-high", taskId: "t1", outcome: "failure" }).state;
  state = applyAgentDispatchOutcome(state, { role: "executor-high", taskId: "t1", outcome: "failure" }).state;
  state = applyAgentDispatchOutcome(state, { role: "executor-high", taskId: "t1", outcome: "failure" }).state;
  assert.equal(decideAgentRetryAllowed(state, { role: "executor-high", taskId: "t1" }).ok, false);
  assert.equal(decideAgentRetryAllowed(state, { role: "executor-high", taskId: "t2" }).ok, true);
});
