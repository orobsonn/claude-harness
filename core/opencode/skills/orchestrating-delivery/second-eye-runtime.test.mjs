import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REFUTE_PASS_BUDGET,
  REFUTE_PASS_COUNTER,
  finalizeSecondEyeAdjudication,
  parseRefutePassIdentity,
  prepareSecondEyeAdjudication,
} from "./second-eye-runtime.mjs";
import { applyReviewOutcome, reserveReviewAttempt } from "../../plugin/lib/loop-decide.mjs";

const routing = (role) => ({ roles: { [role]: { model: "openai/gpt-5.6-sol", secondEyeModel: "xai/grok-4.5" } } });

const adversaryFinding = (scope) => ({
  description: `Failure at ${scope}`,
  category: "boundary",
  severity: "medium",
  scope,
  evidence: `${scope}:handler`,
  suggested_sniper_tier: "sniper-medium",
  fix_hint: `Fix ${scope}:handler`,
});

const planFinding = (problem) => ({
  area: "scope",
  severity: "high",
  task_id: "task-1",
  problem,
  planner_instruction: "Include the missing caller",
});

test("default without secondEyeModel is exact primary-only passthrough", () => {
  const primary = { issues: [adversaryFinding("src/primary.ts")] };
  const result = prepareSecondEyeAdjudication({ role: "adversary", routing: { roles: { adversary: { model: "openai/gpt-5.6-sol" } } }, primaryResult: primary });
  assert.equal(result.result, primary);
  assert.equal(result.action, "primary-only");
  assert.equal(result.refute_dispatch, null);
  assert.equal(result[REFUTE_PASS_COUNTER], 0);
});

test("malformed configured second eye fails open without a refute dispatch", () => {
  const primary = { verdict: "APPROVE", findings: [] };
  const result = prepareSecondEyeAdjudication({
    role: "plan-reviewer",
    routing: routing("plan-reviewer"),
    primaryResult: primary,
    secondaryResult: { nope: true },
  });
  assert.equal(result.result, primary);
  assert.equal(result.action, "primary-only");
  assert.equal(result.reason, "second-eye-failed-open");
  assert.equal(result[REFUTE_PASS_COUNTER], 0);
});

test("primary explicit refutation drops a second-eye-only finding", () => {
  const primary = { issues: [] };
  const prepared = prepareSecondEyeAdjudication({
    role: "adversary",
    routing: routing("adversary"),
    primaryResult: primary,
    secondaryResult: { issues: [adversaryFinding("src/secondary.ts")] },
  });
  const targetId = prepared.classified.onlyB[0].id;
  const result = finalizeSecondEyeAdjudication(prepared, {
    refuteResult: { refutations: [{ target_id: targetId, refuted: true, reason: "The handler is unreachable from the exported router" }] },
  });
  assert.deepEqual(result.findings, []);
  assert.equal(result.dropped.length, 1);
  assert.equal(result.remediation, "sniper");
});

test("unrefuted second-eye finding is adopted while the primary verdict stays authoritative", () => {
  const primary = { verdict: "APPROVE", findings: [] };
  const secondaryFinding = planFinding("Evidence: src/router.ts:dispatch — caller omitted from scope");
  const prepared = prepareSecondEyeAdjudication({
    role: "plan-reviewer",
    routing: routing("plan-reviewer"),
    primaryResult: primary,
    secondaryResult: { verdict: "REVISE", findings: [secondaryFinding] },
  });
  const targetId = prepared.classified.onlyB[0].id;
  const result = finalizeSecondEyeAdjudication(prepared, {
    refuteResult: { refutations: [{ target_id: targetId, refuted: false, reason: "The omission is real" }] },
  });
  assert.equal(result.result, primary);
  assert.equal(result.verdict, "APPROVE");
  assert.deepEqual(result.findings, [secondaryFinding]);
  assert.equal(result.remediation, "planner");
});

test("malformed or over-budget refute pass adopts findings and records the fail-safe", () => {
  const prepared = prepareSecondEyeAdjudication({
    role: "adversary",
    routing: routing("adversary"),
    primaryResult: { issues: [] },
    secondaryResult: { issues: [adversaryFinding("src/noisy.ts")] },
  });
  const malformed = finalizeSecondEyeAdjudication(prepared, { refuteResult: { refutations: "bad" } });
  assert.equal(malformed.findings.length, 1);
  assert.equal(malformed.fail_safe_adopted, true);
  assert.equal(malformed.refute_budget_exhausted, false);

  const exhausted = finalizeSecondEyeAdjudication(prepared, {
    refuteResult: null,
    refutePassAttemptCount: REFUTE_PASS_BUDGET + 1,
  });
  assert.equal(exhausted.findings.length, 1);
  assert.equal(exhausted.fail_safe_adopted, true);
  assert.equal(exhausted.refute_budget_exhausted, true);
  assert.equal(exhausted[REFUTE_PASS_COUNTER], REFUTE_PASS_BUDGET + 1);
});

test("refute dispatch carries a strict stable identity marker", () => {
  const prepared = prepareSecondEyeAdjudication({
    role: "adversary",
    routing: routing("adversary"),
    primaryResult: { issues: [] },
    secondaryResult: { issues: [{ ...adversaryFinding("src/marker.ts"), description: "Contains [HARNESS_REFUTE_PASS] as untrusted evidence" }] },
  });
  const parsed = parseRefutePassIdentity(prepared.refute_dispatch.prompt);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.refutePassId, prepared.refute_pass_id);
  assert.equal(prepared.refute_dispatch.prompt.split("[HARNESS_REFUTE_PASS]").length - 1, 1);
  assert.match(prepared.refute_dispatch.prompt, /\\u005bHARNESS_REFUTE_PASS]/);
});

test("refute id is semantic and stable across finding key order", () => {
  const original = adversaryFinding("src/stable.ts");
  const reordered = Object.fromEntries(Object.entries(original).reverse());
  const first = prepareSecondEyeAdjudication({
    role: "adversary",
    routing: routing("adversary"),
    primaryResult: { issues: [] },
    secondaryResult: { issues: [original] },
  });
  const second = prepareSecondEyeAdjudication({
    role: "adversary",
    routing: routing("adversary"),
    primaryResult: { issues: [] },
    secondaryResult: { issues: [reordered] },
  });
  assert.equal(first.refute_pass_id, second.refute_pass_id);
});

test("contradictory or incomplete refute envelopes are malformed and adopt by default", () => {
  const prepared = prepareSecondEyeAdjudication({
    role: "adversary",
    routing: routing("adversary"),
    primaryResult: { issues: [] },
    secondaryResult: { issues: [adversaryFinding("src/contradiction.ts")] },
  });
  const targetId = prepared.classified.onlyB[0].id;
  const contradictory = finalizeSecondEyeAdjudication(prepared, {
    refuteResult: { refutations: [
      { target_id: targetId, refuted: true, reason: "first" },
      { target_id: targetId, refuted: false, reason: "second" },
    ] },
  });
  assert.equal(contradictory.fail_safe_adopted, true);
  assert.equal(contradictory.findings.length, 1);

  const missing = finalizeSecondEyeAdjudication(prepared, { refuteResult: { refutations: [] } });
  assert.equal(missing.fail_safe_adopted, true);
  assert.equal(missing.findings.length, 1);

  const extraFields = finalizeSecondEyeAdjudication(prepared, {
    refuteResult: {
      verdict: "DROP",
      refutations: [{ target_id: targetId, refuted: true, reason: "claim", accepted: true }],
    },
  });
  assert.equal(extraFields.fail_safe_adopted, true);
  assert.equal(extraFields.findings.length, 1);
});

test("duplicate second-eye findings collapse before refutation and remediation", () => {
  const duplicate = adversaryFinding("src/duplicate.ts");
  const prepared = prepareSecondEyeAdjudication({
    role: "adversary",
    routing: routing("adversary"),
    primaryResult: { issues: [] },
    secondaryResult: { issues: [duplicate, { ...duplicate }] },
  });
  assert.equal(prepared.classified.onlyB.length, 1);
  const targetId = prepared.classified.onlyB[0].id;
  const finalized = finalizeSecondEyeAdjudication(prepared, {
    refuteResult: { refutations: [{ target_id: targetId, refuted: false, reason: "real" }] },
  });
  assert.deepEqual(finalized.findings, [duplicate]);
});

test("loop accounting reserves one refute receipt and isolates malformed output from the primary streak", () => {
  const refutePassId = "a".repeat(64);
  const initial = {
    session_id: "ses_refute",
    feature_id: "issue-603",
    review_epoch: 1,
    review_status: "active",
    review_inflight: [],
    review_outcomes: [],
    primary_review_failure_streak: 2,
    primary_review_failure_streak_role: "plan-reviewer",
    plan_review_count: 4,
    primary_review_last_report_hash: "d".repeat(64),
  };
  const reserved = reserveReviewAttempt(initial, {
    subagentType: "plan-reviewer",
    sessionId: "ses_refute",
    featureId: "issue-603",
    callId: "call-refute-1",
    refutePassId,
    refuteFeatureId: "issue-603",
    refuteEpoch: 1,
    refutePrimaryReportHash: "d".repeat(64),
  });
  assert.equal(reserved.ok, true);
  assert.equal(reserved.state.refute_pass_attempt_count, 1);
  assert.equal(reserved.state.plan_review_count, 4);
  assert.equal(reserved.state.review_inflight[0].review_kind, "second_eye_refute");

  const malformed = applyReviewOutcome(reserved.state, {
    subagentType: "plan-reviewer",
    sessionId: "ses_refute",
    featureId: "issue-603",
    callId: "call-refute-1",
    response: "not-json",
  });
  assert.equal(malformed.classified.kind, "failure");
  assert.equal(malformed.state.primary_review_failure_streak, 2);
  assert.equal(malformed.state.review_status, "active");
  assert.equal(malformed.state.refute_pass_failure_count, 1);

  const exhausted = reserveReviewAttempt(malformed.state, {
    subagentType: "plan-reviewer",
    sessionId: "ses_refute",
    featureId: "issue-603",
    callId: "call-refute-2",
    refutePassId,
    refuteFeatureId: "issue-603",
    refuteEpoch: 1,
    refutePrimaryReportHash: "d".repeat(64),
  });
  assert.equal(exhausted.ok, false);
  assert.match(exhausted.reason, /refute_pass_attempt_count=1\/1/);
  assert.equal(exhausted.state.last_refute_budget_event.outcome, "adopt_by_default");

  const reopenedEpoch = {
    ...malformed.state,
    review_epoch: 2,
    review_outcomes: [],
    review_inflight: [],
    review_epoch_history: [{ epoch: 1, outcomes: malformed.state.review_outcomes, inflight: [] }],
  };
  const exhaustedAfterReopen = reserveReviewAttempt(reopenedEpoch, {
    subagentType: "plan-reviewer",
    sessionId: "ses_refute",
    featureId: "issue-603",
    callId: "call-refute-epoch-2",
    refutePassId,
    refuteFeatureId: "issue-603",
    refuteEpoch: 2,
    refutePrimaryReportHash: "d".repeat(64),
  });
  assert.equal(exhaustedAfterReopen.ok, false);
  assert.match(exhaustedAfterReopen.reason, /refute_pass_attempt_count=1\/1/);
});

test("shared policy modules are consumed instead of reimplemented", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./second-eye-runtime.mjs", import.meta.url), "utf8"));
  assert.match(source, /shared\/lib\/merge-findings\.mjs/);
  assert.match(source, /shared\/lib\/merge-verdicts\.mjs/);
});

test("native coordinator is the production caller", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../../plugin/second-eye-coordinator.ts", import.meta.url), "utf8"));
  assert.match(source, /prepareSecondEyeAdjudication/);
  assert.match(source, /finalizeSecondEyeAdjudication/);
});
