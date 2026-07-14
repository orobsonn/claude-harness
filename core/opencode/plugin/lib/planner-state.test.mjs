/** @description Pure concurrency, replay, and lease probes for planner attempt state. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  PLANNER_ATTEMPT_LEASE_MS,
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

test("late output and rejection cannot overwrite a newer active attempt", () => {
  const first = claim(BASE);
  const failed = failPlannerAttempt(first.state, { callId: "call-1", token: "token-1", failureClass: "timeout", providerUnavailable: true, hasFallback: true, now: 2_000 });
  const fallback = claimPlannerAttempt(failed.state, {
    role: "planner-fallback", callId: "call-2", token: "token-2", sessionId: "session-1", featureId: "feature",
    model: "other/model", baselinePlan: { fingerprint: "old" }, hasFallback: true, now: 3_000,
  });
  const lateOutput = completePlannerAttempt(fallback.state, { callId: "call-1", token: "token-1", resultKind: "usable_plan", planHash: "late", now: 4_000 });
  const lateError = failPlannerAttempt(lateOutput.state, { callId: "call-1", token: "token-1", failureClass: "auth", hasFallback: true, now: 4_000 });
  assert.equal(lateOutput.accepted, false);
  assert.equal(lateError.accepted, false);
  assert.equal(lateError.state.planner_active_attempt.call_id, "call-2");
});

test("expired primary converges to fallback_pending; expired fallback is terminal", () => {
  const first = claim(BASE);
  const primaryExpired = reconcilePlannerLease(first.state, { now: 1_000 + PLANNER_ATTEMPT_LEASE_MS, hasFallback: true });
  assert.equal(primaryExpired.state.planner_retry_outcome, "fallback_pending");
  assert.equal(primaryExpired.state.planner_active_attempt, null);
  const fallback = claimPlannerAttempt(primaryExpired.state, {
    role: "planner-fallback", callId: "call-2", token: "token-2", sessionId: "session-1", featureId: "feature",
    model: "other/model", baselinePlan: { fingerprint: "old" }, hasFallback: true, now: 400_000,
  });
  const fallbackExpired = reconcilePlannerLease(fallback.state, { now: 400_000 + PLANNER_ATTEMPT_LEASE_MS, hasFallback: true });
  assert.equal(fallbackExpired.state.planner_retry_outcome, "fallback_failed");
  assert.equal(fallbackExpired.state.delivery_status, "delivery-blocked");
});

test("terminal planner states reject both primary and fallback claims until explicit reset", () => {
  for (const terminal of [
    { planner_retry_outcome: "fallback_failed", delivery_status: "delivery-blocked" },
    { planner_status: "planner_failed", delivery_status: "delivery-blocked" },
    { planner_status: "planner_unavailable", delivery_status: "delivery-blocked" },
  ]) {
    assert.equal(claim({ ...BASE, ...terminal }).ok, false);
    assert.equal(claimPlannerAttempt({ ...BASE, ...terminal }, {
      role: "planner-fallback", callId: "fallback", token: "token", sessionId: "session-1",
      featureId: "feature", model: "other/model", hasFallback: true, now: 1_000,
    }).ok, false);
  }
  const reset = { ...BASE, planner_status: "planner_failed", delivery_status: "delivery-blocked", ...plannerCycleResetPatch() };
  assert.equal(claim(reset).ok, true);
});
