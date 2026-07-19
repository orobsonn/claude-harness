/** @description Focused review reservation, terminal outcome, signed dual, and epoch restart tests. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyReviewOutcome,
  classifyReviewBoundaryError,
  decideReviewCapBeforeWriting,
  reopenReviewEpoch,
  reserveReviewAttempt,
} from "./loop-decide.mjs";
import { createLoopGuardHooks } from "../loop-guard.ts";
import { createEntryGateHooks } from "../entry-gate.ts";
import { sealedMarkerRecord, validatePrivilegedMarkerSeals } from "./marker-seal.mjs";
import { decideDualBeforeDelivery } from "./dual-enforcement.mjs";
import { isRecordedDualAttempt } from "../../../shared/lib/gate-state-shape.mjs";
import { captureSpecAdversaryResult, completionEvidence } from "./ceremony-transition.mjs";
import { semanticPlanHash, writeBoundPlanSnapshot } from "./planner-artifact.mjs";

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
  assert.equal(validatePrivilegedMarkerSeals(first.state, { sessionId: SESSION, featureId: FEATURE }).ok, true);

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
  assert.equal(validatePrivilegedMarkerSeals(primary, { sessionId: SESSION, featureId: FEATURE }).ok, true);
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
  assert.equal(validatePrivilegedMarkerSeals(secondary, { sessionId: SESSION, featureId: FEATURE }).ok, true);

  const failedSecondary = complete(primary, {
    subagentType: "plan-reviewer-family-2",
    callId: "secondary-failed",
    failureClass: "provider_error",
  }).state;
  assert.equal(failedSecondary.dual_status?.plan_review, "primary_only");
  assert.equal(failedSecondary.dual_secondary_status, "failed");
  assert.equal(failedSecondary.dual_secondary_failure_class, "provider_error");
  assert.equal(validatePrivilegedMarkerSeals(failedSecondary, { sessionId: SESSION, featureId: FEATURE }).ok, true);
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
  assert.equal(decideDualBeforeDelivery({
    subagentType: "executor-high",
    gateState: result.state,
    routing: { constraints: { requireDualOn: ["plan-reviewer"] } },
    toolName: "task",
  }).decision, "deny");
});

test("applyReviewOutcome plan-reviewer useful APPROVE → plan_verdict APPROVE", () => {
  const result = complete(state(), { callId: "approve-1", response: report("APPROVE") });
  assert.equal(result.accepted, true);
  assert.equal(result.classified.kind, "useful");
  assert.equal(result.state.plan_verdict, "APPROVE");
});

test("REVISE + dual_status both → dual does NOT unlock hand (money-preflight)", () => {
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
  assert.equal(d.decision, "deny");
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
  const base = state({ plan_review_count: 3 });
  const winner = reserveReviewAttempt(base, input({ callId: "winner" }));
  assert.equal(winner.ok, true);
  assert.equal(winner.state.plan_review_count, 3);
  const loser = reserveReviewAttempt(winner.state, input({ callId: "loser" }));
  assert.equal(loser.ok, false);
  assert.match(loser.reason, /no remaining.*slot/);

  const failed = applyReviewOutcome(winner.state, input({ callId: "winner", failureClass: "timeout" }));
  assert.equal(failed.state.plan_review_count, 3);
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
  for (let round = 1; round <= 4; round += 1) {
    capped = complete(capped, { callId: `cap-${round}`, response: report("REVISE", [finding]) }).state;
  }
  assert.equal(capped.review_status, "review_cap_reached");
  assert.equal(capped.cap_generation, GENERATION_1);
  assert.equal(capped.cap_snapshot_hash, "a".repeat(64));
  assert.equal(reserveReviewAttempt(capped, input({ callId: "new-report-hash", response: report() })).ok, false);
  assert.equal(decideReviewCapBeforeWriting({ subagentType: "executor-high", gateState: capped }).decision, "deny");

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
    assert.equal(reopened.state.review_epoch_history[0].outcomes.length, 4);
    assert.equal(applyReviewOutcome(reopened.state, input({ callId: "cap-4", response: report() })).accepted, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("boundary taxonomy is bounded and does not consume useful cap", () => {
  assert.equal(classifyReviewBoundaryError({ statusCode: 401 }), "unauthenticated");
  assert.equal(classifyReviewBoundaryError({ statusCode: 403, message: "policy denied" }), "denied");
  assert.equal(classifyReviewBoundaryError(new Error("deadline exceeded")), "timeout");
  assert.equal(classifyReviewBoundaryError({ statusCode: 503 }), "provider_error");
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
    fs.writeFileSync(file, JSON.stringify(state({ plan_review_count: 3 })));
    const hooks = await createLoopGuardHooks(root);
    const dispatch = (callID) => hooks["tool.execute.before"](
      { tool: "task", sessionID: SESSION, callID },
      { args: { subagent_type: "plan-reviewer-family-1", feature_id: FEATURE, task_id: "task-1", phase: "plan" } },
    );
    const results = await Promise.allSettled([dispatch("slot-a"), dispatch("slot-b")]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.plan_review_count, 3);
    assert.equal(persisted.review_inflight.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("classifyReviewBoundaryError distinguishes 402/429 from generic provider_error", () => {
  assert.equal(classifyReviewBoundaryError({ statusCode: 402 }), "credit");
  assert.equal(classifyReviewBoundaryError({ statusCode: 429 }), "rate_limited");
  assert.equal(classifyReviewBoundaryError({ message: "rate limit exceeded" }), "rate_limited");
  assert.equal(classifyReviewBoundaryError({ statusCode: 503 }), "provider_error");
});

test("primary_failure_cap_reached blocks writing hands", () => {
  const d = decideReviewCapBeforeWriting({
    subagentType: "executor-high",
    gateState: { review_status: "primary_failure_cap_reached" },
  });
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /primary_failure_cap_reached/);
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
