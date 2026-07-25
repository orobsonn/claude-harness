/** @description Pure concurrency and claim probes for planner attempt state (primary-only, no lease kill). */
import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PRIMARY_ATTEMPTS,
  PLANNER_SESSION_DISPATCH_CEILING,
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

test("round-budget deny escalates in product language instead of dying on an engineering string", () => {
  const spent = claim({ ...BASE, planner_primary_attempts: MAX_PRIMARY_ATTEMPTS });
  assert.equal(spent.ok, false);
  // The live deadlock ended the turn on "planner primary attempt bound reached" — no instruction,
  // no product framing, so the orchestrator stopped silently with the operator none the wiser.
  assert.match(spent.reason, /do NOT re-dispatch/i);
  assert.match(spent.reason, /report the blocking finding to the operator/i);
});

test("session dispatch ceiling is absolute: no reset path clears it", () => {
  const atCeiling = { ...BASE, planner_dispatches_total: PLANNER_SESSION_DISPATCH_CEILING };
  const denied = claim(atCeiling);
  assert.equal(denied.ok, false);
  assert.match(denied.reason, /session ceiling/i);
  assert.match(denied.reason, /new session/i);

  // The per-round credit clears planner_primary_attempts; it must NOT buy past the ceiling.
  assert.equal(claim({ ...atCeiling, planner_primary_attempts: 0 }).ok, false);
  // Neither may the verified cycle reset.
  const reset = { ...atCeiling, ...plannerCycleResetPatch() };
  assert.equal(reset.planner_dispatches_total, PLANNER_SESSION_DISPATCH_CEILING);
  assert.equal(claim(reset).ok, false);
});

test("cycle reset clears the round stamp so a restarted cycle still earns its round credit", () => {
  const patch = plannerCycleResetPatch();
  assert.equal(patch.planner_attempts_round, 0);
  assert.equal(patch.planner_primary_attempts, 0);
  assert.equal("planner_dispatches_total" in patch, false);
});

test("a claim counts against both the round budget and the session ceiling", () => {
  const first = claim(BASE);
  assert.equal(first.state.planner_primary_attempts, 1);
  assert.equal(first.state.planner_dispatches_total, 1);
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
