/** @description Planner identity lifecycle probes without retry or review budgets. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  bindPlannerArtifact,
  claimPlannerAttempt,
  completePlannerAttempt,
  failPlannerAttempt,
  plannerCycleResetPatch,
} from "./planner-state.mjs";

const base = { feature_id: "feature", classified: true };
const expectedModelStrategy = {
  hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" },
  planner: "openai/gpt-5.6-sol",
  "plan-reviewer": "openai/gpt-5.6-sol",
  compliance: "openai/gpt-5.6-terra",
  adversary: "openai/gpt-5.6-sol",
  security: "openai/gpt-5.6-sol",
  shipper: "openai/gpt-5.6-luna",
  harvester: "openai/gpt-5.6-luna",
};
const claim = (state, overrides = {}) => claimPlannerAttempt(state, {
  role: "planner",
  callId: "call-1",
  token: "token-1",
  sessionId: "session-1",
  featureId: "feature",
  model: "openai/model",
  baselinePlan: { fingerprint: "old" },
  ...overrides,
});

test("a new planner call supersedes an unfinished claim while duplicate before is idempotent", () => {
  const first = claim(base);
  assert.equal(first.ok, true);
  const next = claim(first.state, { callId: "call-2", token: "token-2" });
  assert.equal(next.ok, true);
  assert.equal(next.state.planner_active_attempt.call_id, "call-2");
  assert.equal(claim(first.state).idempotent, true);
});

test("a stale result cannot replace the active planner identity", () => {
  const first = claim(base);
  const failed = failPlannerAttempt(first.state, { callId: "call-1", token: "token-1", failureClass: "timeout" });
  const second = claim(failed.state, { callId: "call-2", token: "token-2" });
  const late = completePlannerAttempt(second.state, { callId: "call-1", token: "token-1", resultKind: "usable_plan" });
  assert.equal(late.accepted, false);
  assert.equal(late.state.planner_active_attempt.call_id, "call-2");
});

test("a canonical plan binds only to its matching planner identity", () => {
  const first = claim(base);
  const returned = completePlannerAttempt(first.state, {
    callId: "call-1", token: "token-1", resultKind: "usable_plan", planHash: "hash",
  });
  const bound = bindPlannerArtifact(returned.state, {
    sessionId: "session-1", featureId: "feature",
  artifact: { valid: true, semanticHash: "hash", fileHash: "file", fingerprint: "new", plan: { feature_id: "feature" } },
    expectedModelStrategy,
  });
  assert.equal(bound.ok, true);
  assert.equal(bound.state.planner_status, "usable");
});

test("classify reset contains identity fields, not runtime budgets", () => {
  const reset = plannerCycleResetPatch();
  assert.deepEqual(Object.keys(reset).sort(), [
    "planner_active_attempt", "planner_binding_error", "planner_last_attempt", "planner_plan_binding", "planner_status",
  ]);
});
