/**
 * @description Deterministic "keep reviewing until APPROVE" nudge for the plan-review loop.
 *
 * Why this exists: a REVISE verdict hard-blocks every writing hand (dual-enforcement:
 * "plan_verdict REVISE — executor blocked until plan-review APPROVE"), but nothing told the
 * orchestrator to re-dispatch the plan-reviewer. Observed failure: the orchestrator stopped
 * after round 2 of a 5-round budget with an unresolved HIGH finding, leaving the run unable
 * to review (nobody dispatched) and unable to implement (hands denied) — a silent stall with
 * the gate never denying anything.
 *
 * Pure and side-effect free: the caller (loop-guard) owns reading the freshly persisted state
 * and mutating `output.metadata`. Mirrors dual-nudge.mjs / agent-idle-nudge.mjs, whose message
 * channel (`output.metadata.<key>`) is the only prose channel the OC runtime actually delivers —
 * `decideLoopGuard`'s warn string has no consumer and must never be used for this.
 */
import { reviewAgentIdentity } from "../../agents/review-catalog.mjs";
import { thresholdsFor, loopCounterKey } from "./loop-decide.mjs";

/** Verdict that releases the writing hands; anything else keeps them blocked. */
const APPROVED = "APPROVE";

/** Review statuses under which reserveReviewAttempt refuses a new slot until a verified restart. */
const REVIEW_CAP_STATUSES = new Set(["review_cap_reached", "primary_failure_cap_reached"]);

function object(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * @description Decide whether to inject a plan-review continuation nudge after an outcome.
 * Only the primary (loop-counting) plan-reviewer triggers it — family-2 is optional and
 * fail-open, so its return must never drive the loop.
 * @param {{ state?: unknown, subagentType?: unknown, overrides?: object }} input
 * @returns {{ action: "inject", context: string, kind: "continue" | "cap" }
 *          | { action: "skip", reason: string }}
 */
export function decideReviseNudge(input = {}) {
  const identity = reviewAgentIdentity(input.subagentType);
  if (!identity) return { action: "skip", reason: "not-a-review-agent" };
  if (identity.logicalRole !== "plan-reviewer") return { action: "skip", reason: "not-plan-reviewer" };
  if (identity.primary !== true) return { action: "skip", reason: "secondary-family-never-drives-the-loop" };

  const state = object(input.state);
  const verdict = typeof state.plan_verdict === "string" ? state.plan_verdict : null;
  if (verdict === APPROVED) return { action: "skip", reason: "plan approved" };
  if (!verdict) return { action: "skip", reason: "no plan verdict recorded yet" };

  const key = loopCounterKey(identity.canonicalName);
  const { deny } = thresholdsFor(key, object(input.overrides));
  const count = Number.isInteger(state[key]) && state[key] >= 0 ? state[key] : 0;
  // Both cap statuses make reserveReviewAttempt refuse the next slot, so neither may be told
  // to re-dispatch — a nudge that invites a guaranteed-denied dispatch is worse than silence.
  const capReached = REVIEW_CAP_STATUSES.has(state.review_status) || count >= deny;

  if (capReached) {
    return {
      action: "inject",
      kind: "cap",
      context:
        `[revise-nudge] plan-review budget exhausted (${count}/${deny}) and plan_verdict is still ${verdict}. ` +
        "STOP re-dispatching the plan-reviewer: the next dispatch will be refused. The writing hands stay " +
        "blocked by design. Escalate the blocking finding to the operator in product language, or restart " +
        "the ceremony with a new generation and plan binding (a verified restart resets this budget).",
    };
  }

  const remaining = deny - count;
  const unresolved = state.primary_review_last_material_unresolved === true;
  return {
    action: "inject",
    kind: "continue",
    context:
      `[revise-nudge] plan-review round ${count}/${deny} returned ${verdict}` +
      `${unresolved ? " with a material finding still unresolved" : ""}. ` +
      "Every writing hand (executor / sniper / test-author) is HARD-BLOCKED until plan_verdict is APPROVE — " +
      "dispatching one now will be denied. Do NOT stop here and do NOT hand this back to the operator. " +
      "Next action, in this order: (1) re-dispatch `planner` — you do NOT edit the plan yourself, the plugin " +
      "is its sole author, and the harness injects the reviewer's instructions into the planner's brief " +
      "automatically; (2) then re-dispatch the plan-reviewer for " +
      `round ${count + 1}. Re-reviewing the SAME plan cannot change the verdict: the peer family's REVISE ` +
      "stands until the plan is re-bound, so skipping the planner burns a round for nothing. " +
      `${remaining} round(s) remain before the budget is exhausted. ` +
      "Continuing past a warning threshold is expected — cross-family rounds past the first have found real defects.",
  };
}
