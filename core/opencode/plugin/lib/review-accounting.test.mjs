/** @description Focused review reservation, terminal outcome, signed dual, and epoch restart tests. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  LOOP_THRESHOLDS,
  PLAN_REVIEW_ROUND_CEILING,
  PLAN_REVIEW_ROUND_WARN_AT,
  applyReviewOutcome,
  classifyReviewBoundaryError,
  decideLoopGuard,
  decidePlanReviewRoundRail,
  reopenReviewEpoch,
  reserveReviewAttempt,
} from "./loop-decide.mjs";
import { createLoopGuardHooks } from "../loop-guard.ts";
import { createEntryGateHooks } from "../entry-gate.ts";
import { sealedMarkerRecord } from "./marker-seal.mjs";
import { decideDualBeforeDelivery } from "./dual-enforcement.mjs";
import { isRecordedDualAttempt } from "../../../shared/lib/gate-state-shape.mjs";
import {
  AGENT_RETRY_K,
  applyAgentDispatchOutcome,
  applyGateBlockedDispatch,
  decideGateBlockedDispatchAllowed,
} from "../../../shared/lib/agent-retry.mjs";
import { PLANNER_SESSION_DISPATCH_CEILING } from "./planner-state.mjs";
import { captureSpecAdversaryResult, completionEvidence } from "./ceremony-transition.mjs";
import { semanticPlanHash, writeBoundPlanSnapshot } from "./planner-artifact.mjs";
import { isolateObservabilityRunPath } from "./obs-test-isolation.mjs";

isolateObservabilityRunPath();

const SESSION = "ses-review-accounting";
const FEATURE = "review-accounting";
const GENERATION_1 = "11111111-1111-4111-8111-111111111111";
const GENERATION_2 = "22222222-2222-4222-8222-222222222222";
const finding = {
  area: "introduced-risk",
  severity: "high",
  task_id: "task-1",
  problem: "A concurrent completion can overwrite state.",
  planner_instruction: "Serialize the state transition under the existing lock.",
};

function report(verdict = "APPROVE", findings = []) {
  return JSON.stringify({ verdict, findings });
}

function input(overrides = {}) {
  const family2 = overrides.subagentType === "plan-reviewer-family-2";
  return {
    subagentType: "plan-reviewer-family-1",
    sessionId: SESSION,
    featureId: FEATURE,
    callId: "call-1",
    taskId: "task-1",
    phase: "plan",
    response: family2 ? JSON.stringify({ verdict: "APPROVE", family: "family-2", findings: [] }) : report(),
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    session_id: SESSION,
    feature_id: FEATURE,
    ceremony_generation: GENERATION_1,
    planner_plan_binding: { snapshot_hash: "a".repeat(64) },
    ...overrides,
  };
}

function canonicalRestartState(root, capped) {
  const next = { ...capped, ceremony_generation: GENERATION_2 };
  const planDir = path.join(root, ".opencode", "plans", `${SESSION}-${FEATURE}`);
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(path.join(planDir, "spec.md"), "# approved successor spec\n");
  assert.equal(captureSpecAdversaryResult(root, {
    sessionId: SESSION,
    featureId: FEATURE,
    generation: GENERATION_2,
    callId: "successor-adversary",
    role: "adversary-family-1",
    output: '{"issues":[]}',
  }), true);
  const brainstormEvidence = completionEvidence(root, next, "brainstormed");
  const adversaryEvidence = completionEvidence(root, next, "adversary_fired");
  assert.equal(brainstormEvidence.ok, true);
  assert.equal(adversaryEvidence.ok, true);
  const brainstorm = sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "brainstormed", payload: true });
  const adversary = sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "adversary_fired", payload: true });
  const plan = {
    feature_id: FEATURE,
    kind: "full",
    mode: "full",
    tasks: [{
      id: "task-1",
      severity: "medium",
      complexity: "medium",
      scope_paths: ["core/opencode/plugin/"],
      criterion_refs: ["#ac-1.1"],
      locked_tests: [{ id: "lt-1", path: "core/opencode/plugin/lib/review-accounting.test.mjs", assertion: "Given review, When accounted, Then ok" }],
    }],
  };
  const hash = semanticPlanHash(plan);
  const bound = writeBoundPlanSnapshot(root, SESSION, { valid: true, semanticHash: hash, plan });
  assert.equal(bound.ok, true);
  const oldSeals = Array.isArray(capped.marker_seals) ? capped.marker_seals.filter((item) => item.operation === "dual") : [];
  return {
    ...next,
    brainstormed: true,
    adversary_fired: true,
    brainstormed_binding: { session_id: SESSION, feature_id: FEATURE, operation: "brainstormed", seal: brainstorm.seal },
    adversary_fired_binding: { session_id: SESSION, feature_id: FEATURE, operation: "adversary_fired", seal: adversary.seal },
    marker_seals: [...oldSeals, brainstorm, adversary],
    ceremony_evidence: { brainstormed: brainstormEvidence.evidence, adversary_fired: adversaryEvidence.evidence },
    planner_plan_binding: {
      session_id: SESSION,
      feature_id: FEATURE,
      snapshot_hash: hash,
      snapshot_path: bound.relativePath,
    },
  };
}

function complete(previous, values = {}) {
  const args = input(values);
  const reserved = reserveReviewAttempt(previous, args);
  assert.equal(reserved.ok, true, reserved.reason);
  return applyReviewOutcome(reserved.state, args);
}

test("usable family-1 terminal increments exactly once; failures are separate and replay is inert", () => {
  const first = complete(state());
  assert.equal(first.state.plan_review_count, 1);
  assert.equal(first.state.dual_status?.plan_review, "primary_only");
  assert.equal(first.state.dual_status?.adversary, undefined);

  const replay = applyReviewOutcome(first.state, input());
  assert.equal(replay.accepted, false);
  assert.equal(replay.state.plan_review_count, 1);

  let current = replay.state;
  for (const [callId, response, failureClass] of [
    ["empty", "", "empty"],
    ["prose", "looks good", "malformed"],
    ["shape", '{"verdict":"APPROVE"}', "malformed"],
  ]) {
    const result = complete(current, { callId, response });
    current = result.state;
    assert.equal(result.classified.failureClass, failureClass);
    assert.equal(current.plan_review_count, 1);
  }
  assert.equal(current.primary_review_failure_count, 3);
  assert.equal(current.primary_review_failure_streak, 3);
  assert.equal(current.review_outcomes.length, 4);

  const blocked = reserveReviewAttempt(current, input({ callId: "denied", response: "Permission denied by policy" }));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /primary_failure_cap_reached|primary failure-cap/);
  assert.equal(current.review_status, "primary_failure_cap_reached");
});

test("primary failure streak cap default 3 denies the 4th dispatch; useful resets streak", () => {
  let current = state();
  for (let index = 0; index < 3; index += 1) {
    const result = complete(current, { callId: `malformed-${index}`, response: "not-json" });
    current = result.state;
    assert.equal(result.classified.failureClass, "malformed");
    assert.equal(current.primary_review_failure_streak, index + 1);
    assert.equal(current.plan_review_count, undefined);
  }
  assert.equal(current.review_status, "primary_failure_cap_reached");

  const fourth = reserveReviewAttempt(current, input({ callId: "malformed-3", response: "still-bad" }));
  assert.equal(fourth.ok, false);
  assert.match(fourth.reason, /primary_failure_cap_reached|primary failure-cap/);

  const useful = complete(state({ primary_review_failure_streak: 2 }), {
    callId: "recover",
    response: report(),
  });
  assert.equal(useful.classified.kind, "useful");
  assert.equal(useful.state.primary_review_failure_streak, 0);
  assert.equal(useful.state.plan_review_count, 1);

  const afterUseful = complete(useful.state, { callId: "after-useful-malformed", response: "prose" });
  assert.equal(afterUseful.state.primary_review_failure_streak, 1);
  assert.equal(afterUseful.state.plan_review_count, 1);
});

test("primary failure cap counts family-1 inflight so concurrent fan-out cannot exceed budget", () => {
  let current = state();
  for (let index = 0; index < 3; index += 1) {
    const reserved = reserveReviewAttempt(current, input({ callId: `inflight-${index}` }));
    assert.equal(reserved.ok, true, reserved.reason);
    current = reserved.state;
  }
  assert.equal(current.review_inflight.length, 3);
  const fourth = reserveReviewAttempt(current, input({ callId: "inflight-3" }));
  assert.equal(fourth.ok, false);
  assert.match(fourth.reason, /primary failure-cap/);
  assert.match(fourth.reason, /inflight_family1=3/);
});

test("valid primary review signs primary_only and permits hand progression; useful secondary signs both", () => {
  const primary = complete(state()).state;
  assert.equal(primary.plan_verdict, "APPROVE");
  assert.equal(decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: primary,
    routing: { constraints: { requireDualOn: ["plan-reviewer"] } },
    toolName: "task",
  }).decision, "allow");

  const secondary = complete(primary, { subagentType: "plan-reviewer-family-2", callId: "secondary" }).state;
  assert.equal(secondary.dual_status?.plan_review, "both");
  assert.equal(secondary.dual_status?.adversary, undefined);
  assert.equal(secondary.plan_verdict, "APPROVE");

  const failedSecondary = complete(primary, {
    subagentType: "plan-reviewer-family-2",
    callId: "secondary-failed",
    failureClass: "provider_error",
  }).state;
  assert.equal(failedSecondary.dual_status?.plan_review, "primary_only");
  assert.equal(failedSecondary.dual_secondary_status, "failed");
  assert.equal(failedSecondary.dual_secondary_failure_class, "provider_error");
});

test("a harness-gate deny on the secondary eye does not degrade the dual to primary_only", () => {
  // The eye never ran — the deny is evidence about the dispatch, not about the second family.
  // A real run lost its cross-family plan review to two self-inflicted plan-gate denials.
  const primary = complete(state()).state;
  assert.equal(primary.dual_status?.plan_review, "primary_only");

  const gateDenied = complete(primary, {
    subagentType: "plan-reviewer-family-2",
    callId: "secondary-gate-blocked",
    failureClass: "gate_blocked",
    error: "[plan-gate] delivery-blocked: planner usable bound artifact required",
  }).state;

  assert.equal(gateDenied.dual_secondary_status, undefined);
  assert.equal(gateDenied.dual_secondary_failure_class, undefined);
  assert.equal(gateDenied.secondary_review_failure_streak ?? 0, 0);
  assert.equal(gateDenied.review_failure_counts.gate_blocked, 1);
  assert.equal(gateDenied.last_provider_diagnostic, undefined);
  assert.ok(gateDenied.last_gate_diagnostic);

  // The second family stays dispatchable and can still sign both.
  const secondary = complete(gateDenied, { subagentType: "plan-reviewer-family-2", callId: "secondary-ok" }).state;
  assert.equal(secondary.dual_status?.plan_review, "both");
});

test("a harness-gate deny on the primary eye never trips the primary failure cap", () => {
  let next = state();
  for (const callId of ["gate-1", "gate-2", "gate-3", "gate-4"]) {
    next = complete(next, { callId, failureClass: "gate_blocked", error: "[plan-gate] delivery-blocked: x" }).state;
  }
  assert.equal(next.primary_review_failure_streak ?? 0, 0);
  assert.notEqual(next.review_status, "primary_failure_cap_reached");
});

test("applyReviewOutcome plan-reviewer useful REVISE → plan_verdict REVISE on state", () => {
  const result = complete(state(), {
    callId: "revise-1",
    response: report("REVISE", [finding]),
  });
  assert.equal(result.accepted, true);
  assert.equal(result.classified.kind, "useful");
  assert.equal(result.state.plan_verdict, "REVISE");
  assert.equal(result.state.dual_status?.plan_review, "primary_only");
  // #483: dual/plan_verdict is record-only on the dispatch surface — REVISE no longer denies.
  assert.equal(decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: result.state,
    routing: { constraints: { requireDualOn: ["plan-reviewer"] } },
    toolName: "task",
  }).decision, "allow");
});

test("applyReviewOutcome plan-reviewer useful APPROVE → plan_verdict APPROVE", () => {
  const result = complete(state(), { callId: "approve-1", response: report("APPROVE") });
  assert.equal(result.accepted, true);
  assert.equal(result.classified.kind, "useful");
  assert.equal(result.state.plan_verdict, "APPROVE");
});

test("REVISE + dual_status both → record-only allow, no longer blocks hand (#483 supersedes money-preflight deny)", () => {
  const revised = complete(state(), {
    callId: "r1",
    response: report("REVISE", [finding]),
  }).state;
  const both = complete(revised, {
    subagentType: "plan-reviewer-family-2",
    callId: "r1-f2",
    response: JSON.stringify({
      verdict: "APPROVE",
      family: "family-2",
      findings: [],
    }),
  }).state;
  assert.equal(both.dual_status?.plan_review, "both");
  assert.equal(both.plan_verdict, "REVISE");
  const d = decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: both,
    routing: { constraints: { requireDualOn: ["plan-reviewer"] } },
    toolName: "task",
  });
  assert.equal(d.decision, "allow");
  assert.match(d.reason, /REVISE/);
});

test("dual pair both APPROVE after either-REVISE → plan_verdict APPROVE unlocks hand", () => {
  // Simulate a fixed plan re-reviewed by both families APPROVE on the same scope.
  const f1Rev = complete(state(), {
    callId: "pair-r1",
    response: report("REVISE", [finding]),
  }).state;
  assert.equal(f1Rev.plan_verdict, "REVISE");
  // Fresh primary APPROVE (new call) + secondary APPROVE on same scope → either-REVISE-wins
  // uses current pair reports, not forever-sticky prior REVISE alone.
  const f1Ok = complete(f1Rev, {
    callId: "pair-a1",
    response: report("APPROVE"),
  }).state;
  const bothOk = complete(f1Ok, {
    subagentType: "plan-reviewer-family-2",
    callId: "pair-a2",
    response: JSON.stringify({
      verdict: "APPROVE",
      family: "family-2",
      findings: [],
    }),
  }).state;
  assert.equal(bothOk.dual_status?.plan_review, "both");
  assert.equal(bothOk.plan_verdict, "APPROVE");
  assert.equal(
    decideDualBeforeDelivery({
      subagentType: "executor-high",
      gateState: bothOk,
      routing: { constraints: { requireDualOn: ["plan-reviewer"] } },
      toolName: "task",
    }).decision,
    "allow",
  );
});

test("#383 applyReviewOutcome plan-reviewer writes dual_status.plan_review not adversary", () => {
  const result = complete(state(), { callId: "pr-axis", response: report("APPROVE") });
  assert.equal(result.state.dual_status?.plan_review, "primary_only");
  assert.equal(result.state.dual_status?.adversary, undefined);
  assert.equal(isRecordedDualAttempt(result.state.dual_status?.adversary), false);
});

test("#383 applyReviewOutcome adversary writes dual_status.adversary not plan_review", () => {
  const result = complete(state(), {
    callId: "adv-axis",
    subagentType: "adversary-family-1",
    phase: "task-adversary",
    response: JSON.stringify({ issues: [] }),
  });
  assert.equal(result.accepted, true, result.classified?.reason ?? result.classified?.kind);
  assert.equal(result.state.dual_status?.adversary, "primary_only");
  assert.equal(result.state.dual_status?.plan_review, undefined);
  assert.equal(result.state.plan_verdict, undefined);
});

test("#383 plan_review dual both does not record adversary axis", () => {
  const primary = complete(state()).state;
  const both = complete(primary, {
    subagentType: "plan-reviewer-family-2",
    callId: "pr-f2",
  }).state;
  assert.equal(both.dual_status?.plan_review, "both");
  assert.equal(both.dual_status?.adversary, undefined);
  assert.equal(isRecordedDualAttempt(both.dual_status?.adversary), false);
});

test("integrated primary completion produces a host-valid primary_only accepted by entry-gate", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-entry-integration-"));
  try {
    const brainstorm = sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "brainstormed", payload: true });
    const adversary = sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "adversary_fired", payload: true });
    const fidelity = `${FEATURE}/task-1`;
    const fidelitySeal = sealedMarkerRecord({ sessionId: SESSION, featureId: FEATURE, operation: "fidelity", payload: fidelity });
    const ceremony = state({
      mode: "FULL",
      classified: true,
      brainstormed: true,
      adversary_fired: true,
      fidelity_pass: [fidelity],
      regate_pending: [],
      regate_passed: [],
      hand_finished: [],
      capture_verified: [],
      marker_seals: [brainstorm, adversary, fidelitySeal],
      brainstormed_binding: { session_id: SESSION, feature_id: FEATURE, operation: "brainstormed", seal: brainstorm.seal },
      adversary_fired_binding: { session_id: SESSION, feature_id: FEATURE, operation: "adversary_fired", seal: adversary.seal },
    });
    const completed = complete(ceremony).state;
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(completed));
    const hooks = await createEntryGateHooks(root);
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION, callID: "executor-call" },
      { args: {
        subagent_type: "executor-high",
        feature_id: FEATURE,
        task_id: "task-1",
        prompt: '[HARNESS_TASK_CONTEXT]{"task_id":"task-1"}[/HARNESS_TASK_CONTEXT]',
      } },
    ));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("primary reservations consume remaining slots atomically without incrementing useful count", () => {
  const lastSlot = LOOP_THRESHOLDS.plan_review.deny - 1;
  const base = state({ plan_review_count: lastSlot });
  const winner = reserveReviewAttempt(base, input({ callId: "winner" }));
  assert.equal(winner.ok, true);
  assert.equal(winner.state.plan_review_count, lastSlot);
  const loser = reserveReviewAttempt(winner.state, input({ callId: "loser" }));
  assert.equal(loser.ok, false);
  assert.match(loser.reason, /no remaining.*slot/);

  const failed = applyReviewOutcome(winner.state, input({ callId: "winner", failureClass: "timeout" }));
  assert.equal(failed.state.plan_review_count, lastSlot);
  assert.equal(reserveReviewAttempt(failed.state, input({ callId: "replacement" })).ok, true);
});

test("reservation derives feature from session-bound state and rejects conflicting identities", () => {
  const derived = reserveReviewAttempt(state(), input({ featureId: undefined }));
  assert.equal(derived.ok, true, derived.reason);
  assert.equal(derived.reservation.feature_id, FEATURE);

  const conflictingFeature = reserveReviewAttempt(state(), input({ featureId: "other-feature" }));
  assert.equal(conflictingFeature.ok, false);
  assert.equal(conflictingFeature.reason, "review reservation identity mismatch");

  const conflictingSession = reserveReviewAttempt(state({ session_id: "other-session" }), input({ featureId: undefined }));
  assert.equal(conflictingSession.ok, false);
  assert.equal(conflictingSession.reason, "review reservation identity mismatch");

  const unsafeFeature = reserveReviewAttempt(state({ feature_id: "../other-feature" }), input({ featureId: undefined }));
  assert.equal(unsafeFeature.ok, false);
  assert.equal(unsafeFeature.reason, "review reservation identity mismatch");
});

test("#ac-2.4 an adversary reservation in a cold repo (no session_id/feature_id stamped yet) does not die on identity-mismatch", () => {
  // Cold: gate-state is a genuinely fresh {} (e.g. the very first spec-adversary attack, before
  // classify has stamped session_id/feature_id on disk) — "not yet bound" must bind to whatever
  // THIS reservation supplies, not read as a mismatch.
  const cold = reserveReviewAttempt({}, input({
    subagentType: "adversary-family-1",
    taskId: "",
    phase: "",
    featureId: FEATURE,
  }));
  assert.equal(cold.ok, true, cold.reason);
  assert.equal(cold.reservation.session_id, SESSION);
  assert.equal(cold.reservation.feature_id, FEATURE);

  // A REAL mismatch (state already bound to something else) must still refuse.
  const stillMismatches = reserveReviewAttempt({ session_id: "other-session" }, input({
    subagentType: "adversary-family-1",
    taskId: "",
    phase: "",
    featureId: FEATURE,
    callId: "still-mismatched",
  }));
  assert.equal(stillMismatches.ok, false);
  assert.equal(stillMismatches.reason, "review reservation identity mismatch");

  // Cold state with no featureId supplied either has no safe identity to bind — still refused.
  const noFeatureAtAll = reserveReviewAttempt({}, input({
    subagentType: "adversary-family-1",
    taskId: "",
    phase: "",
    featureId: undefined,
    callId: "no-feature",
  }));
  assert.equal(noFeatureAtAll.ok, false);
  assert.equal(noFeatureAtAll.reason, "review reservation identity mismatch");
});

test("first terminal outcome wins in both error-after orders", () => {
  const firstReservation = reserveReviewAttempt(state(), input({ callId: "error-first" })).state;
  const errorFirst = applyReviewOutcome(firstReservation, input({ callId: "error-first", failureClass: "provider_error" }));
  const lateAfter = applyReviewOutcome(errorFirst.state, input({ callId: "error-first", response: report() }));
  assert.equal(lateAfter.accepted, false);
  assert.equal(lateAfter.state.primary_review_failure_count, 1);
  assert.equal(lateAfter.state.plan_review_count, undefined);

  const secondReservation = reserveReviewAttempt(errorFirst.state, input({ callId: "after-first" })).state;
  const afterFirst = applyReviewOutcome(secondReservation, input({ callId: "after-first", response: report() }));
  const lateError = applyReviewOutcome(afterFirst.state, input({ callId: "after-first", failureClass: "timeout" }));
  assert.equal(lateError.accepted, false);
  assert.equal(lateError.state.plan_review_count, 1);
  assert.equal(lateError.state.primary_review_failure_count, 1);
});

test("current epoch keeps more than 64 receipts and old calls cannot replay", () => {
  let current = state();
  for (let index = 0; index < 80; index += 1) {
    current = complete(current, {
      subagentType: "plan-reviewer-family-2",
      callId: `secondary-${index}`,
    }).state;
  }
  assert.equal(current.review_outcomes.length, 80);
  assert.equal(applyReviewOutcome(current, input({ subagentType: "plan-reviewer-family-2", callId: "secondary-0" })).accepted, false);
});

test("APPROVE findings remain useful; medium/high unresolved is independently material", () => {
  const low = { ...finding, severity: "low" };
  const approved = complete(state(), { response: report("APPROVE", [low, { ...finding, severity: "medium" }]) });
  assert.equal(approved.classified.kind, "useful");
  assert.equal(approved.classified.materialUnresolved, true);
  assert.equal(approved.state.plan_review_count, 1);
});

test("NOT_IN_SCHEMA enums and ref fields are malformed for both canonical contracts", () => {
  const badPlan = complete(state(), {
    callId: "bad-plan-enum",
    response: report("APPROVE", [{ ...finding, area: "NOT_IN_SCHEMA" }]),
  });
  assert.equal(badPlan.classified.failureClass, "malformed");
  assert.equal(badPlan.state.plan_review_count, undefined);

  const extraRef = complete(badPlan.state, {
    callId: "bad-plan-ref",
    response: report("APPROVE", [{ ...finding, refutes: { target_id: "x", target_family: "family-2", reason: "no" } }]),
  });
  assert.equal(extraRef.classified.failureClass, "malformed");

  const adversary = complete(extraRef.state, {
    subagentType: "adversary-family-1",
    callId: "bad-adversary-enum",
    response: JSON.stringify({ issues: [{
      description: "trigger",
      category: "NOT_IN_SCHEMA",
      severity: "high",
      scope: "src/file.ts",
      evidence: "fn",
      suggested_sniper_tier: "sniper-high",
      fix_hint: "src/file.ts:fn:change",
    }] }),
  });
  assert.equal(adversary.classified.failureClass, "malformed");
  assert.equal(adversary.state.adversary_loop_count, undefined);
});

test("cap cannot reopen from a new report hash; explicit newer generation plus new snapshot opens a new epoch", () => {
  let capped = state();
  for (let round = 1; round <= LOOP_THRESHOLDS.plan_review.deny; round += 1) {
    capped = complete(capped, { callId: `cap-${round}`, response: report("REVISE", [finding]) }).state;
  }
  assert.equal(capped.review_status, "review_cap_reached");
  assert.equal(capped.cap_generation, GENERATION_1);
  assert.equal(capped.cap_snapshot_hash, "a".repeat(64));
  assert.equal(reserveReviewAttempt(capped, input({ callId: "new-report-hash", response: report() })).ok, false);
  // #ac-1.2: review_cap_reached no longer freezes writing hands — decideReviewCapBeforeWriting
  // was removed. The review reservation budget above is still enforced (a verified restart is
  // still required for another review round); only the writing-hand block is gone.

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-canonical-restart-"));
  try {
    assert.equal(captureSpecAdversaryResult(root, {
      sessionId: SESSION,
      featureId: FEATURE,
      generation: GENERATION_2,
      callId: "denied-adversary",
      role: "adversary-family-1",
      output: "Permission denied by runtime",
    }), false);
    assert.equal(completionEvidence(root, { ...capped, ceremony_generation: GENERATION_2 }, "adversary_fired").ok, false);
    const forgedGeneration = reopenReviewEpoch({ ...capped, ceremony_generation: "generation-forged" }, { projectRoot: root });
    assert.equal(forgedGeneration.ok, false);
    const canonical = canonicalRestartState(root, capped);
    const reopened = reopenReviewEpoch(canonical, { projectRoot: root });
    assert.equal(reopened.ok, true);
    assert.equal(reopened.state.review_epoch, 2);
    assert.equal(reopened.state.review_outcomes.length, 0);
    assert.equal(reopened.state.review_epoch_history[0].outcomes.length, LOOP_THRESHOLDS.plan_review.deny);
    assert.equal(
      applyReviewOutcome(
        reopened.state,
        input({ callId: `cap-${LOOP_THRESHOLDS.plan_review.deny}`, response: report() }),
      ).accepted,
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("boundary taxonomy is bounded and does not consume useful cap", () => {
  assert.equal(classifyReviewBoundaryError({ statusCode: 401 }), "unauthenticated");
  assert.equal(classifyReviewBoundaryError({ statusCode: 403, message: "policy denied" }), "denied");
  assert.equal(classifyReviewBoundaryError(new Error("deadline exceeded")), "timeout");
  assert.equal(classifyReviewBoundaryError({ statusCode: 503 }), "upstream_5xx");
  const result = complete(state({ primary_review_failure_count: 1000 }), { failureClass: "timeout" });
  assert.equal(result.state.primary_review_failure_count, 1000);
  assert.equal(result.state.plan_review_count, undefined);
});

test("hook persists reservations before dispatch and consumes them after completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-hook-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state()));
    const hooks = await createLoopGuardHooks(root);
    const runtimeInput = { tool: "task", sessionID: SESSION, callID: "hook-call" };
    const output = {
      args: {
        description: "Review the plan",
        prompt: "Review the canonical plan without prior verdicts.",
        subagent_type: "plan-reviewer-family-1",
      },
      output: report(),
    };
    await hooks["tool.execute.before"](runtimeInput, output);
    let persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.plan_review_count, undefined);
    assert.equal(persisted.review_inflight.length, 1);
    assert.equal(persisted.review_inflight[0].feature_id, FEATURE);
    await hooks["tool.execute.after"](runtimeInput, output);
    persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.review_inflight.length, 0);
    assert.equal(persisted.plan_review_count, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#482 hook round-rail: real dispatches warn past the documented cap and hard-deny past the runaway ceiling — interactive only", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-rail-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state()));
    const args = {
      description: "Review the plan",
      prompt: "Review the canonical plan without prior verdicts.",
      subagent_type: "plan-reviewer-family-1",
    };

    // Resolve each dispatch as a harness-gate-blocked failure via BOTH the event path AND
    // tool.execute.after (OC really fires both for the same Task — the codebase's own
    // decideCallOutcomeOnce dedup exists exactly because of this). classifyReviewBoundaryError
    // tags it "gate_blocked", which clears inflight WITHOUT touching plan_review_count or the
    // primary failure streak — isolating this test to the round-rail dispatch counter only. The
    // round-rail's warn is injected in tool.execute.after (its output truly has a `metadata`
    // field on the wire — tool.execute.before's output type is `{ args }` only, so a warn written
    // there would silently vanish, which is exactly the bug an adversarial review caught).
    async function dispatchOnce(hooks, callId) {
      const runtimeInput = { tool: "task", sessionID: SESSION, callID: callId };
      const output = { args, metadata: {} };
      await hooks["tool.execute.before"](runtimeInput, output);
      await hooks.event({
        event: {
          type: "message.part.updated",
          properties: {
            part: {
              type: "tool",
              tool: "task",
              sessionID: SESSION,
              callID: callId,
              state: {
                status: "error",
                input: args,
                metadata: {},
                error: "[plan-gate] delivery-blocked: isolating this dispatch for the round-rail test",
              },
            },
          },
        },
      });
      output.output = "[plan-gate] delivery-blocked: isolating this dispatch for the round-rail test";
      await hooks["tool.execute.after"](runtimeInput, output);
      return output;
    }

    const interactiveHooks = await createLoopGuardHooks(root);
    let lastOutput;
    for (let round = 1; round <= 3; round += 1) {
      lastOutput = await dispatchOnce(interactiveHooks, `rr-${round}`);
    }
    assert.equal(lastOutput.metadata.loop_guard_warning, undefined, "round 3 is still below the churn-warning threshold");

    // #ac-2.1: round 5 (past the churn-warning threshold) → visible warning, still permits.
    await dispatchOnce(interactiveHooks, "rr-4");
    lastOutput = await dispatchOnce(interactiveHooks, "rr-5");
    assert.match(lastOutput.metadata.loop_guard_warning, /\[loop-guard\]/);
    // #529: the warning is a churn signal, never a second numbered budget competing with the nudge.
    assert.doesNotMatch(lastOutput.metadata.loop_guard_warning, /\bcaps?\b/i);
    assert.doesNotMatch(lastOutput.metadata.loop_guard_warning, /\bhard stop\b/i);

    for (let round = 6; round <= PLAN_REVIEW_ROUND_CEILING; round += 1) {
      await dispatchOnce(interactiveHooks, `rr-${round}`);
    }

    // #ac-2.2: the dispatch past the runaway ceiling, interactive session → hard deny.
    await assert.rejects(
      () => dispatchOnce(interactiveHooks, `rr-${PLAN_REVIEW_ROUND_CEILING + 1}`),
      /\[loop-guard\] Blocked/,
    );

    // #ac-2.2: round 11, headless (CLAUDE_CODE_REMOTE present) → warns only, still permits.
    const originalRemote = process.env.CLAUDE_CODE_REMOTE;
    process.env.CLAUDE_CODE_REMOTE = "1";
    try {
      const headlessHooks = await createLoopGuardHooks(root);
      for (let round = 1; round <= PLAN_REVIEW_ROUND_CEILING; round += 1) {
        await dispatchOnce(headlessHooks, `hl-${round}`);
      }
      const headlessPastCeiling = await dispatchOnce(headlessHooks, `hl-${PLAN_REVIEW_ROUND_CEILING + 1}`);
      assert.match(headlessPastCeiling.metadata.loop_guard_warning, /headless fleet session/);
    } finally {
      if (originalRemote === undefined) delete process.env.CLAUDE_CODE_REMOTE;
      else process.env.CLAUDE_CODE_REMOTE = originalRemote;
    }

    // #ac-2.3: a fleet-look-alike env (HARNESS_NOTIFY_PROJECT set) WITHOUT CLAUDE_CODE_REMOTE
    // must NOT bypass the interactive hard-stop.
    const originalNotify = process.env.HARNESS_NOTIFY_PROJECT;
    process.env.HARNESS_NOTIFY_PROJECT = "/tmp/notify";
    try {
      const fleetLookAlikeHooks = await createLoopGuardHooks(root);
      for (let round = 1; round <= PLAN_REVIEW_ROUND_CEILING; round += 1) {
        await dispatchOnce(fleetLookAlikeHooks, `fl-${round}`);
      }
      await assert.rejects(
        () => dispatchOnce(fleetLookAlikeHooks, `fl-${PLAN_REVIEW_ROUND_CEILING + 1}`),
        /\[loop-guard\] Blocked/,
      );
    } finally {
      if (originalNotify === undefined) delete process.env.HARNESS_NOTIFY_PROJECT;
      else process.env.HARNESS_NOTIFY_PROJECT = originalNotify;
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hook leaves a durable escalation trace when the spec-adversary loop stops converging", async () => {
  // With no deterministic cap, the nudge is the entire stop mechanism — so an ignored escalation
  // must still be VISIBLE. Prose nobody records fails exactly like prose nobody obeys.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-escalation-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state({
      adversary_loop_count: LOOP_THRESHOLDS.adversary.deny,
      review_outcomes: Array.from({ length: LOOP_THRESHOLDS.adversary.deny }, (_, index) => ({
        logical_role: "adversary",
        family: 1,
        task_id: "",
        outcome: "useful",
        identity_hash: `prior-spec-${index + 1}`,
      })),
    })));
    const hooks = await createLoopGuardHooks(root);
    const runtimeInput = { tool: "task", sessionID: SESSION, callID: "escalate-call" };
    const output = {
      args: { description: "Attack the spec", prompt: "Attack the spec.", subagent_type: "adversary-family-1" },
      output: JSON.stringify({ issues: [{
        description: "The vault boundary accepts ISO text.",
        category: "boundary",
        severity: "high",
        scope: "src/db/vault.ts",
        evidence: "vault.ts:writeToTable",
        suggested_sniper_tier: "sniper-high",
        fix_hint: "src/db/vault.ts:writeToTable:reject",
      }] }),
    };
    await hooks["tool.execute.before"](runtimeInput, output);
    await hooks["tool.execute.after"](runtimeInput, output);

    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    // The dispatch itself was never refused, and no capped status was written.
    assert.equal(persisted.review_status, undefined);
    assert.match(output.metadata.adversary_nudge, /STOP re-attacking/);
    // The trace is what makes an ignored escalation auditable.
    assert.equal(typeof persisted.spec_adversary_escalation, "object");
    assert.equal(persisted.spec_adversary_escalation.round, LOOP_THRESHOLDS.adversary.deny + 1);
    assert.equal(persisted.spec_adversary_escalation.report_hash, persisted.primary_review_last_report_hash);
    assert.match(persisted.spec_adversary_escalation.at, /^\d{4}-\d{2}-\d{2}T/);
    // And the residual risk was snapshotted for the planner brief in the same pass.
    assert.equal(persisted.spec_adversary_open_risks[0].scope, "src/db/vault.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hook rejects a gate-state whose embedded session differs from its runtime path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-session-mismatch-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const mismatched = state({ session_id: "other-session" });
    fs.writeFileSync(file, JSON.stringify(mismatched));
    const hooks = await createLoopGuardHooks(root);
    await assert.rejects(() => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION, callID: "mismatched-session-call" },
      { args: {
        description: "Review the plan",
        prompt: "Review the canonical plan without prior verdicts.",
        subagent_type: "plan-reviewer-family-1",
      } },
    ), /review reservation identity mismatch/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), mismatched);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("dual dispatch with official Task command/task_id does not deny reservation identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-command-hygiene-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state()));
    const hooks = await createLoopGuardHooks(root);
    // Official OC Task schema may carry command/task_id for resume — not harness role.
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION, callID: "dual-f1-call" },
      { args: {
        description: "Review the plan",
        prompt: "Review the canonical plan without prior verdicts.",
        subagent_type: "plan-reviewer-family-1",
        command: "resume-or-skill-command",
        task_id: "official-host-resume-id",
      } },
    ));
    await assert.doesNotReject(() => hooks["tool.execute.before"](
      { tool: "agent", sessionID: SESSION, callID: "dual-f2-call" },
      { args: {
        description: "Secondary family review",
        prompt: "Review without prior verdicts.",
        subagent_type: "plan-reviewer-family-2",
        command: "another-host-command",
        task_id: "other-official-resume-id",
      } },
    ));
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.review_inflight.length, 2);
    assert.equal(persisted.review_inflight[0].canonical_identity, "plan-reviewer-family-1");
    assert.equal(persisted.review_inflight[1].canonical_identity, "plan-reviewer-family-2");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent before-hooks compete for the final primary reservation slot", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-slot-concurrency-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state({ plan_review_count: LOOP_THRESHOLDS.plan_review.deny - 1 })));
    const hooks = await createLoopGuardHooks(root);
    const dispatch = (callID) => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION, callID },
      { args: { subagent_type: "plan-reviewer-family-1", feature_id: FEATURE, task_id: "task-1", phase: "plan" } },
    );
    const results = await Promise.allSettled([dispatch("slot-a"), dispatch("slot-b")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.plan_review_count, LOOP_THRESHOLDS.plan_review.deny - 1);
    assert.equal(persisted.review_inflight.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a persisted REVISE verdict carries the continuation nudge back to the orchestrator", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revise-nudge-wiring-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state()));
    const hooks = await createLoopGuardHooks(root);
    const args = {
      subagent_type: "plan-reviewer-family-1",
      feature_id: FEATURE,
      task_id: "task-1",
      phase: "plan",
    };
    const hookInput = { tool: "task", sessionID: SESSION, callID: "nudge-1" };
    await hooks["tool.execute.before"](hookInput, { args });

    const revise = { args, output: report("REVISE", [finding]), metadata: {} };
    await hooks["tool.execute.after"](hookInput, revise);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).plan_verdict, "REVISE");
    assert.match(revise.metadata.revise_nudge, /re-dispatch the plan-reviewer for round 2/);

    // APPROVE closes the loop — no nudge may survive into execution.
    const approveInput = { tool: "task", sessionID: SESSION, callID: "nudge-2" };
    await hooks["tool.execute.before"](approveInput, { args });
    const approve = { args, output: report("APPROVE"), metadata: {} };
    await hooks["tool.execute.after"](approveInput, approve);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).plan_verdict, "APPROVE");
    assert.equal(approve.metadata.revise_nudge, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classifyReviewBoundaryError distinguishes 402/429/5xx from generic provider_error", () => {
  assert.equal(classifyReviewBoundaryError({ statusCode: 402 }), "credit");
  assert.equal(classifyReviewBoundaryError({ statusCode: 429 }), "rate_limited");
  assert.equal(classifyReviewBoundaryError({ message: "rate limit exceeded" }), "rate_limited");
  // Distinct upstream 5xx class (transient) vs generic provider_error (unknown).
  assert.equal(classifyReviewBoundaryError({ statusCode: 500 }), "upstream_5xx");
  assert.equal(classifyReviewBoundaryError({ statusCode: 502 }), "upstream_5xx");
  assert.equal(classifyReviewBoundaryError({ statusCode: 503 }), "upstream_5xx");
  assert.equal(classifyReviewBoundaryError({ message: "who knows" }), "provider_error");
});

test("classifyReviewBoundaryError labels harness-internal deny errors as gate_blocked, not provider_error", () => {
  // Production forensics (ses_084fd366…): a [plan-gate] deny thrown by the harness was
  // being swallowed into provider_error, polluting review_failure_counts and the
  // primary failure streak with a non-provider cause.
  assert.equal(
    classifyReviewBoundaryError(
      new Error("[plan-gate] delivery-blocked: planner usable bound artifact required; status=plan_pending_write"),
    ),
    "gate_blocked",
  );
  assert.equal(classifyReviewBoundaryError("[loop-guard] primary failure-cap: halt"), "gate_blocked");
  assert.equal(classifyReviewBoundaryError("[entry-gate] Blocked: request denied"), "gate_blocked");
  assert.equal(classifyReviewBoundaryError({ message: "[money-preflight] quote required" }), "gate_blocked");
  // Production forensics (ses_069a8f35…): planner-recovery was missing from the tag list, so its
  // own "attempt bound reached" deny was charged to the planner's K=3 QUALITY budget
  // (agent_dispatch_failures.planner). Three of those permanently ban an agent that never ran —
  // and the planner has no fallback ladder, so the run deadlocks in the planning phase.
  assert.equal(
    classifyReviewBoundaryError(new Error("[planner-recovery] delivery-blocked: planner primary attempt bound reached")),
    "gate_blocked",
  );
  assert.equal(classifyReviewBoundaryError("[plan-write-gate] delivery-blocked: canonical plan write denied"), "gate_blocked");
  assert.equal(classifyReviewBoundaryError("[marker-authority] seal mismatch"), "gate_blocked");
  // A genuine provider error is NOT reclassified.
  assert.equal(classifyReviewBoundaryError({ statusCode: 429, message: "rate limit" }), "rate_limited");
});

test("a persisted REVISE credits a fresh planner round budget, exactly once, and only forward", () => {
  const revise = JSON.stringify({ verdict: "REVISE", findings: [finding] });

  // Round 1 REVISE with the round budget already spent → the next round starts with a full budget.
  const round1 = complete(state({ planner_primary_attempts: 3 }), { callId: "r1", response: revise });
  assert.equal(round1.state.plan_verdict, "REVISE");
  assert.equal(round1.state.plan_review_count, 1);
  assert.equal(round1.state.planner_primary_attempts, 0, "REVISE is an instruction to re-plan, not a planner failure");
  assert.equal(round1.state.planner_attempts_round, 1);

  // A replayed outcome for the same round must not credit again (it would launder the budget).
  const spentAgain = { ...round1.state, planner_primary_attempts: 2 };
  const replay = applyReviewOutcome(spentAgain, input({ callId: "r1", response: revise }));
  assert.equal(replay.accepted, false);
  assert.equal(replay.state.planner_primary_attempts, 2);

  // The round stamp itself, not the receipt dedupe: a FRESH call whose round is already stamped
  // must not credit. Without this assertion the `count > stampedRound` guard could be deleted and
  // the suite would stay green (the replay above is caught by the terminal-outcome check).
  // Round 3 of 5, so the cap is NOT what refuses here — only the stamp is.
  const stampedAhead = complete(
    state({ plan_review_count: 2, planner_attempts_round: 9, planner_primary_attempts: 3 }),
    { callId: "already-stamped", response: revise },
  );
  assert.equal(stampedAhead.state.plan_review_count, 3);
  assert.equal(stampedAhead.state.review_status, undefined);
  assert.equal(stampedAhead.state.planner_attempts_round, 9, "a stamp ahead of the round is not moved backwards");
  assert.equal(stampedAhead.state.planner_primary_attempts, 3, "no credit when the round is already accounted for");

  // APPROVE releases the hands; there is nothing to re-plan, so no credit.
  const approved = complete(state({ planner_primary_attempts: 3 }), { callId: "ok", response: report("APPROVE") });
  assert.equal(approved.state.plan_verdict, "APPROVE");
  assert.equal(approved.state.planner_primary_attempts, 3);
  assert.equal(approved.state.planner_attempts_round, undefined);

  // An adversary round never touches the planner budget.
  const adversary = complete(state({ planner_primary_attempts: 3 }), {
    subagentType: "adversary-family-1",
    callId: "adv",
    response: JSON.stringify({ issues: [] }),
  });
  assert.equal(adversary.state.planner_primary_attempts, 3);
});

test("a broken spec-adversary eye stops being dispatched WITHOUT freezing the run", () => {
  // The live incident's round 1 came back malformed. Two more and `primary_failure_cap_reached`
  // would have denied every writing hand and the delivery for the rest of the run — in a phase
  // where nothing had been written and the planner had not run once.
  const broken = (callId) => input({ subagentType: "adversary-family-1", taskId: "", phase: "", callId, response: "not json at all" });
  let current = state();
  for (let round = 1; round <= LOOP_THRESHOLDS.primary_failure_streak.deny; round += 1) {
    const args = broken(`broken-${round}`);
    const reserved = reserveReviewAttempt(current, args);
    assert.equal(reserved.ok, true, `round ${round}: ${reserved.reason}`);
    const result = applyReviewOutcome(reserved.state, args);
    assert.equal(result.classified.failureClass, "malformed");
    current = result.state;
  }
  assert.equal(current.primary_review_failure_streak, LOOP_THRESHOLDS.primary_failure_streak.deny);
  // No freezing status, and the hands + delivery stay available.
  assert.equal(current.review_status, undefined);
  // The broken eye IS stopped, with an instruction instead of a dead end.
  const again = reserveReviewAttempt(current, broken("broken-extra"));
  assert.equal(again.ok, false);
  assert.match(again.reason, /do NOT re-dispatch it/);
  assert.match(again.reason, /Nothing is frozen/);
  assert.match(again.reason, /report this to the operator/);

  // Crossing the phase boundary: the broken spec eye must NOT bar the next phase's eye. The streak
  // is global to family 1 and its only resets are a family-1 useful outcome or an epoch reopen that
  // needs a cap status the spec carve-out never writes — so a stale streak would refuse every later
  // family-1 eye (plan-reviewer, per-task adversary, final review) before dispatch, permanently, and
  // the "goes to the plan unattacked" instruction would be unfulfillable.
  const stamped = { ...current, adversary_fired: true };
  const planReviewer = reserveReviewAttempt(stamped, input({ callId: "pr-after-broken-spec" }));
  assert.equal(planReviewer.ok, true, planReviewer.reason);
  assert.equal(current.primary_review_failure_streak_role, "adversary", "the streak names the eye that produced it");

  // A broken PLAN-REVIEWER still freezes: there the code exists and cannot be judged.
  let plan = state();
  for (let round = 1; round <= LOOP_THRESHOLDS.primary_failure_streak.deny; round += 1) {
    plan = complete(plan, { callId: `pr-broken-${round}`, response: "not json" }).state;
  }
  assert.equal(plan.review_status, "primary_failure_cap_reached");
  // #ac-1.2: primary_failure_cap_reached still bounds the review reservation itself (asserted
  // above), but no longer blocks executor/sniper/test-author dispatch — decideReviewCapBeforeWriting
  // was removed. See entry-gate.test.mjs's own ac-1.2 coverage through the real hook.
});

test("the spec pass snapshots its material issues so an accepted risk survives the plan-review overwrite", () => {
  const advInput = (callId) => input({
    subagentType: "adversary-family-1",
    taskId: "",
    phase: "",
    callId,
    response: JSON.stringify({ issues: [
      { description: "The vault boundary accepts ISO text.", category: "boundary", severity: "high", scope: "src/db/vault.ts", evidence: "vault.ts:writeToTable", suggested_sniper_tier: "sniper-high", fix_hint: "src/db/vault.ts:writeToTable:reject" },
      { description: "A naming nit.", category: "other", severity: "low", scope: "src/db/leads.ts", evidence: "leads.ts:x", suggested_sniper_tier: "sniper-low", fix_hint: "src/db/leads.ts:x:rename" },
    ] }),
  });
  const after = applyReviewOutcome(reserveReviewAttempt(state(), advInput("adv-1")).state, advInput("adv-1")).state;
  assert.equal(after.spec_adversary_open_risks.length, 1, "only material issues are carried");
  assert.equal(after.spec_adversary_open_risks[0].scope, "src/db/vault.ts");

  // A later plan-review outcome overwrites primary_review_last_report — the snapshot must not move.
  const afterPlanReview = complete({ ...after, adversary_fired: true }, { callId: "pr-1", response: report("REVISE", [finding]) }).state;
  assert.equal(afterPlanReview.spec_adversary_open_risks.length, 1);
  assert.equal(afterPlanReview.spec_adversary_open_risks[0].scope, "src/db/vault.ts");

  // Once the ceremony marker is stamped the spec pass is over: later adversary rounds (per-task
  // attacks during implementation) must not overwrite the accepted spec risks.
  const taskAttack = input({
    subagentType: "adversary-family-1",
    taskId: "task-1",
    phase: "task",
    callId: "task-adv",
    response: JSON.stringify({ issues: [
      { description: "Unrelated implementation defect.", category: "race", severity: "high", scope: "src/x.ts", evidence: "x.ts:y", suggested_sniper_tier: "sniper-high", fix_hint: "src/x.ts:y:lock" },
    ] }),
  });
  const afterTask = applyReviewOutcome(reserveReviewAttempt(afterPlanReview, taskAttack).state, taskAttack).state;
  assert.equal(afterTask.spec_adversary_open_risks[0].scope, "src/db/vault.ts");
});

test("the spec-adversary loop is never refused and never freezes the run", () => {
  // The incident: a spec-REFINEMENT loop hit its cap, wrote review_cap_reached, and froze every
  // writing hand for the rest of the run — in a phase where the planner had not run once.
  const advInput = (overrides = {}) => input({
    subagentType: "adversary-family-1",
    taskId: "",
    phase: "",
    response: JSON.stringify({ issues: [{
      description: "The vault boundary accepts ISO text for the epoch columns.",
      category: "boundary",
      severity: "high",
      scope: "src/db/vault.ts",
      evidence: "vault.ts:writeToTable",
      suggested_sniper_tier: "sniper-high",
      fix_hint: "src/db/vault.ts:writeToTable:reject non-integer timestamps",
    }] }),
    ...overrides,
  });

  let current = state();
  for (let round = 1; round <= LOOP_THRESHOLDS.adversary.deny; round += 1) {
    const result = applyReviewOutcome(
      reserveReviewAttempt(current, advInput({ callId: `adv-${round}` })).state,
      advInput({ callId: `adv-${round}` }),
    );
    assert.equal(result.classified.kind, "useful", `round ${round}`);
    current = result.state;
  }
  assert.equal(current.adversary_loop_count, LOOP_THRESHOLDS.adversary.deny);
  // No status is written at all: an adversary loop must never put the run into a capped state.
  assert.equal(current.review_status, undefined);
  // Past the threshold the dispatch is still ALLOWED — stopping is the orchestrator's call, driven
  // by the escalation nudge. A deterministic refusal here is exactly what stranded two live runs.
  const beyond = reserveReviewAttempt(current, advInput({ callId: "adv-beyond" }));
  assert.equal(beyond.ok, true, beyond.reason);
  assert.equal(decideLoopGuard({ subagentType: "adversary-family-1", count: LOOP_THRESHOLDS.adversary.deny + 5 }).decision, "warn");
  // The plan-review loop is untouched by any of this.
  assert.equal(reserveReviewAttempt(current, input({ callId: "pr-after-spec-rounds" })).ok, true);
});

test("no adversary loop freezes the run — only the plan-review verdict loop does", () => {
  const taskAdv = (callId) => input({
    subagentType: "adversary-family-1",
    taskId: "task-1",
    phase: "task",
    callId,
    response: JSON.stringify({ issues: [{
      description: "Concurrent writers can interleave and lose an update.",
      category: "determinism",
      severity: "high",
      scope: "src/db/leads.ts",
      evidence: "leads.ts:update",
      suggested_sniper_tier: "sniper-high",
      fix_hint: "src/db/leads.ts:update:serialize under the existing lock",
    }] }),
  });
  let current = state();
  for (let round = 1; round <= LOOP_THRESHOLDS.adversary.deny; round += 1) {
    current = applyReviewOutcome(reserveReviewAttempt(current, taskAdv(`t-${round}`)).state, taskAdv(`t-${round}`)).state;
  }
  // The Claude Code variant has no adversary cap and never suffers this stall class. Here there is
  // no deterministic cap either: no status, no refusal, no frozen hand.
  assert.equal(current.review_status, undefined);
  assert.equal(reserveReviewAttempt(current, taskAdv("t-beyond")).ok, true);
  // The plan-review verdict loop is the ONE that still caps the REVIEW RESERVATION itself: REVISE
  // means no further plan-review round without a verified restart. It no longer blocks writing
  // hands either (#ac-1.2, decideReviewCapBeforeWriting removed) — dual/plan_verdict REVISE
  // (dual-enforcement.mjs) is the mechanism that still blocks a hand pending plan-review APPROVE.
  let planLoop = state();
  for (let round = 1; round <= LOOP_THRESHOLDS.plan_review.deny; round += 1) {
    planLoop = complete(planLoop, { callId: `pr-${round}`, response: report("REVISE", [finding]) }).state;
  }
  assert.equal(planLoop.review_status, "review_cap_reached");
});

test("no round credit at the cap: a budget nobody can review is never advertised", () => {
  let current = state();
  for (let round = 1; round < LOOP_THRESHOLDS.plan_review.deny; round += 1) {
    current = complete(current, { callId: `pre-${round}`, response: report("REVISE", [finding]) }).state;
  }
  assert.equal(current.plan_review_count, LOOP_THRESHOLDS.plan_review.deny - 1);
  const atCap = complete({ ...current, planner_primary_attempts: 3 }, { callId: "cap", response: report("REVISE", [finding]) });
  assert.equal(atCap.state.review_status, "review_cap_reached");
  assert.equal(atCap.state.planner_primary_attempts, 3, "the capped round must not credit a planner budget");
  assert.equal(reserveReviewAttempt(atCap.state, input({ callId: "after-cap" })).ok, false);
});

test("the planner session ceiling stays derived from the review cap plus one round of retries", () => {
  // Pinned here (not by importing LOOP_THRESHOLDS into planner-state) because that import would
  // close the loop-decide → review-restart → planner-artifact → planner-state cycle.
  assert.equal(PLANNER_SESSION_DISPATCH_CEILING, LOOP_THRESHOLDS.plan_review.deny + AGENT_RETRY_K);
});

test("a satisfied precondition clears the gate-blocked counter, so K non-consecutive denies cannot ban forever", () => {
  // The planning deadlock survived being reclassified out of the agent's budget precisely because
  // this counter had NO reset path anywhere: the ban just moved counters.
  let current = {};
  for (const taskId of ["", ""]) {
    current = applyGateBlockedDispatch(current, { role: "planner", taskId, reason: "[planner-recovery] denied" }).state;
  }
  assert.equal(current.gate_blocked_dispatches.planner, 2);
  assert.equal(decideGateBlockedDispatchAllowed(current, { role: "planner" }).ok, true);

  const recovered = applyAgentDispatchOutcome(current, { role: "planner", outcome: "success" }).state;
  assert.equal("planner" in recovered.gate_blocked_dispatches, false);
  assert.equal(recovered.gate_blocked_last, null);
  assert.equal(decideGateBlockedDispatchAllowed(recovered, { role: "planner" }).ok, true);

  // Consecutive denials still stop the dispatcher — the anti-runaway property is unchanged.
  let consecutive = {};
  for (let index = 0; index < 3; index += 1) {
    consecutive = applyGateBlockedDispatch(consecutive, { role: "planner" }).state;
  }
  assert.equal(decideGateBlockedDispatchAllowed(consecutive, { role: "planner" }).ok, false);
  // A different key is untouched by the recovered one.
  const other = applyAgentDispatchOutcome(consecutive, { role: "executor-high", outcome: "success" }).state;
  assert.equal(other.gate_blocked_dispatches.planner, 3);
});

test("reopening a capped review epoch resets the round stamp with the counter it indexes", () => {
  // Without this, a verified restart inherits a stamp of N, silently refuses the credit for rounds
  // 1..N, and the restarted run deadlocks EARLIER than an unfixed one.
  let capped = state();
  for (let round = 1; round <= LOOP_THRESHOLDS.plan_review.deny; round += 1) {
    capped = complete(capped, { callId: `stamp-${round}`, response: report("REVISE", [finding]) }).state;
  }
  assert.equal(capped.review_status, "review_cap_reached");
  // The capped round itself does not credit, so the last stamped round is the one before it.
  assert.equal(capped.planner_attempts_round, LOOP_THRESHOLDS.plan_review.deny - 1);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "review-round-stamp-restart-"));
  try {
    const reopened = reopenReviewEpoch(canonicalRestartState(root, capped), { projectRoot: root });
    assert.equal(reopened.ok, true, reopened.reason);
    assert.equal(reopened.state.plan_review_count, 0);
    assert.equal(reopened.state.planner_attempts_round, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("plan-review scope follows the bound plan: a stale peer REVISE from an earlier round cannot pin the verdict", () => {
  const PLAN_A = "a".repeat(64);
  const PLAN_B = "b".repeat(64);
  const revise = JSON.stringify({ verdict: "REVISE", findings: [finding] });
  const reviseFamily2 = JSON.stringify({ verdict: "REVISE", family: "family-2", findings: [finding] });

  // Round 1 on plan A — both families REVISE.
  let current = state({ planner_plan_binding: { snapshot_hash: PLAN_A } });
  current = complete(current, { callId: "r1-f1", response: revise }).state;
  current = complete(current, { callId: "r1-f2", subagentType: "plan-reviewer-family-2", response: reviseFamily2 }).state;
  assert.equal(current.plan_verdict, "REVISE");
  assert.equal(current.dual_status?.plan_review, "both");

  // Same bound plan: either-REVISE-wins must still hold. Nothing was re-planned, so the peer's
  // REVISE is still live evidence about THIS artifact.
  const samePlan = complete(current, { callId: "r1-f1-again", response: report("APPROVE") });
  assert.equal(samePlan.state.plan_verdict, "REVISE", "peer REVISE on the same bound plan still wins");

  // Round 2 after a real re-plan — family-1 APPROVE must NOT be overridden by the plan-A REVISE,
  // even though family-2 never returned on plan B (it malformed live at a 1-in-2 rate). Without
  // this, APPROVE is unreachable and every writing hand stays blocked for the rest of the run.
  const replanned = { ...current, planner_plan_binding: { snapshot_hash: PLAN_B } };
  const round2 = complete(replanned, { callId: "r2-f1", response: report("APPROVE") });
  assert.equal(round2.state.plan_verdict, "APPROVE");
  assert.equal(round2.state.dual_status?.plan_review, "primary_only");
});

test("#ac-2.1/#ac-2.2/#ac-2.3 plan-review round-rail: warns past the churn threshold, denies past the runaway ceiling — interactive only", () => {
  const pastCeiling = PLAN_REVIEW_ROUND_CEILING + 1;

  // Below the churn-warning threshold: allow, no warning.
  assert.equal(
    decidePlanReviewRoundRail({ subagentType: "plan-reviewer-family-1", count: PLAN_REVIEW_ROUND_WARN_AT - 1 }).decision,
    "allow",
  );

  // #ac-2.1: past the churn-warning threshold → visible warning, still permits.
  const warned = decidePlanReviewRoundRail({
    subagentType: "plan-reviewer-family-1",
    count: PLAN_REVIEW_ROUND_WARN_AT + 1,
  });
  assert.equal(warned.ok, true);
  assert.equal(warned.decision, "warn");
  assert.match(warned.reason, /\[loop-guard\]/);

  // #529: this warning rides the SAME metadata channel as revise_nudge, so it must not deliver a
  // second numbered authority — no foreign cap, no stop instruction, no competing round budget.
  assert.doesNotMatch(warned.reason, /\bcaps?\b/i);
  assert.doesNotMatch(warned.reason, /\bhard stop\b/i);
  assert.match(warned.reason, /revise_nudge remains the only authority/);

  // #ac-2.2: past the runaway ceiling, interactive (no CLAUDE_CODE_REMOTE) → hard deny.
  const interactivePastCeiling = decidePlanReviewRoundRail({
    subagentType: "plan-reviewer-family-1",
    count: pastCeiling,
    env: {},
  });
  assert.equal(interactivePastCeiling.ok, false);
  assert.equal(interactivePastCeiling.decision, "deny");
  assert.match(interactivePastCeiling.reason, /\[loop-guard\] Blocked/);

  // #ac-2.2: past the runaway ceiling, headless (CLAUDE_CODE_REMOTE present) → warns only.
  const headlessPastCeiling = decidePlanReviewRoundRail({
    subagentType: "plan-reviewer-family-1",
    count: pastCeiling,
    env: { CLAUDE_CODE_REMOTE: "1" },
  });
  assert.equal(headlessPastCeiling.ok, true);
  assert.equal(headlessPastCeiling.decision, "warn");

  // #ac-2.3: a fleet-look-alike env (HARNESS_NOTIFY_PROJECT set) WITHOUT CLAUDE_CODE_REMOTE must
  // NOT bypass the interactive hard-stop — the signal is exactly Boolean(env.CLAUDE_CODE_REMOTE),
  // mirroring Claude Code entry-gate.mjs:116-118, never another variable.
  const fleetLookAlikePastCeiling = decidePlanReviewRoundRail({
    subagentType: "plan-reviewer-family-1",
    count: pastCeiling,
    env: { HARNESS_NOTIFY_PROJECT: "/tmp/notify" },
  });
  assert.equal(fleetLookAlikePastCeiling.ok, false);
  assert.equal(fleetLookAlikePastCeiling.decision, "deny");

  // The adversary counter is untouched by this round-rail (only plan_review_count is gated).
  assert.equal(decidePlanReviewRoundRail({ subagentType: "adversary-family-1", count: 99 }).decision, "allow");
});

/**
 * #529 — the rail counts DISPATCHES, the budget counts USEFUL rounds. A failed review spends a
 * dispatch without crediting a round, so a ceiling at or below the budget makes the last rounds
 * unreachable and hands the operator a converging review with budget left. Pin the derivation.
 */
test("#529 the plan-review runaway ceiling clears the full review budget plus one round of retries", () => {
  assert.equal(PLAN_REVIEW_ROUND_CEILING, LOOP_THRESHOLDS.plan_review.deny + AGENT_RETRY_K);
  assert.ok(
    PLAN_REVIEW_ROUND_CEILING > LOOP_THRESHOLDS.plan_review.deny,
    "the dispatch ceiling must leave headroom above the useful-round budget",
  );

  // The last useful round must still be dispatchable after a full round of failure retries.
  const lastRoundAfterRetries = LOOP_THRESHOLDS.plan_review.deny + AGENT_RETRY_K;
  assert.notEqual(
    decidePlanReviewRoundRail({
      subagentType: "plan-reviewer-family-1",
      count: lastRoundAfterRetries,
      env: {},
    }).decision,
    "deny",
  );
});

test("applyReviewOutcome stores sanitized provider diagnostic on failure", () => {
  const reserved = reserveReviewAttempt(state(), {
    subagentType: "plan-reviewer-family-1",
    sessionId: SESSION,
    featureId: FEATURE,
    taskId: "",
    phase: "",
    callId: "diag-1",
  });
  assert.equal(reserved.ok, true);
  const result = applyReviewOutcome(reserved.state, {
    subagentType: "plan-reviewer-family-1",
    sessionId: SESSION,
    featureId: FEATURE,
    callId: "diag-1",
    failureClass: "provider_error",
    error: { statusCode: 503, message: "bad gateway api_key=sk-secret-should-redact" },
    model: "xai/grok-4.5",
  });
  assert.equal(result.accepted, true);
  const last = result.state.review_outcomes.at(-1);
  assert.ok(last.diagnostic);
  assert.equal(last.diagnostic.status, 503);
  assert.equal(last.diagnostic.model, "xai/grok-4.5");
  assert.match(String(last.diagnostic.message), /\[redacted\]|bad gateway/);
  assert.ok(!String(last.diagnostic.message).includes("sk-secret"));
  assert.equal(result.state.last_provider_diagnostic.status, 503);
});
