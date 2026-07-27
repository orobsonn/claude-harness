/** @description Tests for the deterministic plan-review continuation nudge. */
import test from "node:test";
import assert from "node:assert/strict";
import { decideReviseNudge } from "./revise-nudge.mjs";
import { LOOP_THRESHOLDS } from "./loop-decide.mjs";

const PRIMARY = "plan-reviewer-family-1";
const SECONDARY = "plan-reviewer-family-2";

test("REVISE below the budget injects a continue nudge naming the next round", () => {
  const res = decideReviseNudge({
    state: { plan_verdict: "REVISE", plan_review_count: 2, primary_review_last_material_unresolved: true },
    subagentType: PRIMARY,
  });
  assert.equal(res.action, "inject");
  assert.equal(res.kind, "continue");
  assert.match(res.context, /round 2\/5/);
  assert.match(res.context, /re-dispatch the plan-reviewer for round 3/);
  assert.match(res.context, /3 round\(s\) remain/);
  assert.match(res.context, /material finding still unresolved/);
  // #483: the dual gate is record-only — the nudge frames this as the orchestrator's
  // obligation, never as a runtime block that will refuse the dispatch.
  assert.match(res.context, /MUST wait for plan_verdict APPROVE/);
  assert.doesNotMatch(res.context, /HARD-BLOCKED/);
  assert.doesNotMatch(res.context, /dispatching one now will be denied/);
});

test("the nudge tells the orchestrator not to stop and not to hand back to the operator", () => {
  const nudge = decideReviseNudge({ state: { plan_verdict: "REVISE", plan_review_count: 1 }, subagentType: PRIMARY });
  // The orchestrator cannot edit the plan (the plugin is its sole author), and re-reviewing the same
  // bound plan cannot change the verdict — the peer family's REVISE stands until the plan is
  // re-bound. A nudge that omits the planner burns the whole review budget without re-planning once.
  assert.match(nudge.context, /re-dispatch `planner`/);
  assert.match(nudge.context, /Re-reviewing the SAME plan cannot change the verdict/);
  assert.equal(/apply the plan-reviewer's planner_instruction to the plan/.test(nudge.context), false);

  const res = decideReviseNudge({ state: { plan_verdict: "REVISE", plan_review_count: 1 }, subagentType: PRIMARY });
  assert.match(res.context, /Do NOT stop here/);
  assert.match(res.context, /do NOT hand this back to the operator/);
});

test("APPROVE never nudges", () => {
  const res = decideReviseNudge({ state: { plan_verdict: "APPROVE", plan_review_count: 3 }, subagentType: PRIMARY });
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "plan approved");
});

test("a missing verdict does not nudge (nothing was reviewed yet)", () => {
  assert.equal(decideReviseNudge({ state: { plan_review_count: 0 }, subagentType: PRIMARY }).action, "skip");
});

test("the optional family-2 eye never drives the loop", () => {
  const res = decideReviseNudge({ state: { plan_verdict: "REVISE", plan_review_count: 1 }, subagentType: SECONDARY });
  assert.equal(res.action, "skip");
  assert.equal(res.reason, "secondary-family-never-drives-the-loop");
});

test("non plan-review roles are ignored", () => {
  assert.equal(decideReviseNudge({ state: { plan_verdict: "REVISE" }, subagentType: "adversary-family-1" }).action, "skip");
  assert.equal(decideReviseNudge({ state: { plan_verdict: "REVISE" }, subagentType: "executor" }).action, "skip");
  assert.equal(decideReviseNudge({ state: { plan_verdict: "REVISE" }, subagentType: undefined }).action, "skip");
});

test("at the budget the nudge flips to escalate — it never invites another round", () => {
  const res = decideReviseNudge({
    state: { plan_verdict: "REVISE", plan_review_count: LOOP_THRESHOLDS.plan_review.deny },
    subagentType: PRIMARY,
  });
  assert.equal(res.kind, "cap");
  assert.match(res.context, /STOP re-dispatching/);
  assert.doesNotMatch(res.context, /re-dispatch the plan-reviewer for round/);
});

test("a primary-failure cap escalates too — its next dispatch would also be refused", () => {
  const res = decideReviseNudge({
    state: { plan_verdict: "REVISE", plan_review_count: 1, review_status: "primary_failure_cap_reached" },
    subagentType: PRIMARY,
  });
  assert.equal(res.kind, "cap");
  assert.match(res.context, /will be refused/);
});

test("an active review cap escalates even when the counter was reset", () => {
  const res = decideReviseNudge({
    state: { plan_verdict: "REVISE", plan_review_count: 0, review_status: "review_cap_reached" },
    subagentType: PRIMARY,
  });
  assert.equal(res.kind, "cap");
});

test("the budget is 5 rounds", () => {
  assert.equal(LOOP_THRESHOLDS.plan_review.deny, 5);
});

test("a corrupt counter degrades to round 0 instead of throwing", () => {
  const res = decideReviseNudge({
    state: { plan_verdict: "REVISE", plan_review_count: "many" },
    subagentType: PRIMARY,
  });
  assert.equal(res.kind, "continue");
  assert.match(res.context, /round 0\/5/);
});

test("a non-object state does not throw", () => {
  assert.equal(decideReviseNudge({ state: null, subagentType: PRIMARY }).action, "skip");
  assert.equal(decideReviseNudge().action, "skip");
});
