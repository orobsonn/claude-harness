/** @description Pure concurrency and claim probes for planner attempt state (primary-only, no lease kill). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  claimPlannerAttempt,
  completePlannerAttempt,
  failPlannerAttempt,
  plannerCycleResetPatch,
  reconcilePlannerLease,
} from "./planner-state.mjs";

const BASE = { feature_id: "feature", classified: true };
const claim = (state, overrides = {}) => claimPlannerAttempt(state, {
  role: "planner",
  callId: "call-1",
  token: "token-1",
  sessionId: "session-1",
  featureId: "feature",
  model: "openai/model",
  baselinePlan: { fingerprint: "old" },
  hasFallback: true,
  now: 1_000,
  ...overrides,
});

test("one active atomic claim excludes concurrent/replayed primary claims", () => {
  const first = claim(BASE);
  assert.equal(first.ok, true);
  assert.equal(claim(first.state, { callId: "call-2", token: "token-2" }).ok, false);
  assert.equal(first.state.planner_primary_attempts, 1);
});

test("same callID re-claim is idempotent (double tool.execute.before / dual plugin load)", () => {
  const first = claim(BASE);
  assert.equal(first.ok, true);
  const again = claim(first.state, { callId: "call-1", token: "token-DIFFERENT" });
  assert.equal(again.ok, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.state.planner_primary_attempts, 1);
  assert.equal(again.state.planner_active_attempt.call_id, "call-1");
  assert.equal(again.state.planner_active_attempt.token, "token-1");
  assert.equal(claim(first.state, { callId: "call-other", token: "token-x" }).ok, false);
});

test("late output and rejection cannot overwrite a newer active attempt", () => {
  const first = claim(BASE);
  const failed = failPlannerAttempt(first.state, {
    callId: "call-1",
    token: "token-1",
    failureClass: "timeout",
    providerUnavailable: true,
    hasFallback: true,
    now: 2_000,
  });
  // Primary-only: after provider blip, may re-claim primary (not fallback).
  assert.equal(failed.state.delivery_status, "planning_revision");
  const second = claim(failed.state, { callId: "call-2", token: "token-2", now: 3_000 });
  assert.equal(second.ok, true);
  const lateOutput = completePlannerAttempt(second.state, {
    callId: "call-1",
    token: "token-1",
    resultKind: "usable_plan",
    planHash: "late",
    now: 4_000,
  });
  const lateError = failPlannerAttempt(lateOutput.state, {
    callId: "call-1",
    token: "token-1",
    failureClass: "auth",
    hasFallback: true,
    now: 4_000,
  });
  assert.equal(lateOutput.accepted, false);
  assert.equal(lateError.accepted, false);
  assert.equal(lateError.state.planner_active_attempt.call_id, "call-2");
});

test("wall-clock does not kill active planner claim (no lease expiry)", () => {
  const first = claim(BASE);
  const later = reconcilePlannerLease(first.state, { now: 1_000 + 60 * 60_000, hasFallback: true });
  assert.equal(later.reconciled, false);
  assert.equal(later.state.planner_active_attempt?.call_id, "call-1");
  assert.equal(later.state.planner_status, "running");
});

test("planner-fallback claims are rejected (primary-only)", () => {
  const denied = claimPlannerAttempt(BASE, {
    role: "planner-fallback",
    callId: "fb",
    token: "t",
    sessionId: "session-1",
    featureId: "feature",
    model: "other/model",
    hasFallback: true,
    now: 1_000,
  });
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /fallback disabled/);
});

test("terminal planner states reject claims until explicit reset", () => {
  for (const terminal of [
    { planner_status: "planner_failed", delivery_status: "delivery-blocked" },
    { planner_status: "planner_unavailable", delivery_status: "delivery-blocked" },
  ]) {
    assert.equal(claim({ ...BASE, ...terminal }).ok, false);
  }
  const reset = {
    ...BASE,
    planner_status: "planner_failed",
    delivery_status: "delivery-blocked",
    ...plannerCycleResetPatch(),
  };
  assert.equal(claim(reset).ok, true);
});

test("invalid plan from primary opens revision not fallback", () => {
  const first = claim(BASE);
  const done = completePlannerAttempt(first.state, {
    callId: "call-1",
    token: "token-1",
    resultKind: "invalid_plan",
    errors: ["bad"],
    now: 2_000,
  });
  assert.equal(done.state.planner_status, "plan_invalid");
  assert.equal(done.state.delivery_status, "planning_revision");
  assert.equal(claim(done.state, { callId: "call-2", token: "token-2", now: 3_000 }).ok, true);
});
