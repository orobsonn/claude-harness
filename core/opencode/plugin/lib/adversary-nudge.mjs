/**
 * @description Deterministic instruction for the SPEC-phase adversary loop.
 *
 * Why this exists: nothing in code defined when a spec-adversary result is "accepted", so the
 * decision lived in the orchestrator's judgement and behaved like a coin flip. Two live sessions,
 * same code, same phase, opposite outcomes: one stamped `adversary_fired` after ONE round with an
 * unresolved material finding and proceeded to the planner; the other rewrote the spec and
 * re-attacked four times — four DIFFERENT reports, every one with a material finding open — until
 * `adversary_loop_count` reached the cap that then existed. The planner never ran once.
 *
 * The written bar ("an empty issues array is clean") is unreachable on a real codebase: an agent
 * whose job is to find failure modes will find one, and every spec rewrite opens fresh surface. So
 * the loop is a treadmill unless acceptance is defined. This module defines it, in one place:
 *
 *   no unresolved material finding  → accept: stamp the marker, go to the planner
 *   material finding, rounds left   → revise spec.md, then re-attack
 *   rounds stop converging          → STOP and escalate to the operator (headless: record as open risks)
 *
 * The third branch is the one the incident lacked: a spec-refinement loop must terminate in a
 * decision, never in a freeze. There is no deterministic cap any more — this instruction IS the
 * stop mechanism, and loop-guard records the escalation in gate-state plus the observability feed so
 * an ignored one is visible rather than silent. Emitted on `output.metadata` — the only prose channel the OC runtime
 * actually delivers (`decideLoopGuard`'s warn string has no consumer and must never be used).
 */
import { reviewAgentIdentity } from "../../agents/review-catalog.mjs";
import { thresholdsFor, loopCounterKey } from "./loop-decide.mjs";

/** Statuses that independently mean the run must stop looping and talk to a human. */
const BUDGET_SPENT_STATUSES = new Set(["review_cap_reached", "primary_failure_cap_reached"]);

function object(value) {
  return value != null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * @description Decide the spec-adversary continuation instruction after a primary outcome.
 * Only the primary (loop-counting) family drives it — family 2 is optional and fail-open. Only the
 * SPEC pass qualifies: a per-task adversary (non-empty task_id) belongs to the implementation loop,
 * whose findings route to a sniper, not to a spec rewrite.
 * @param {{ state?: unknown, subagentType?: unknown, taskId?: unknown, overrides?: object }} input
 * @returns {{ action: "inject", kind: "accept" | "revise" | "escalate", context: string }
 *          | { action: "skip", reason: string }}
 */
export function decideAdversaryNudge(input = {}) {
  const identity = reviewAgentIdentity(input.subagentType);
  if (!identity) return { action: "skip", reason: "not-a-review-agent" };
  if (identity.logicalRole !== "adversary") return { action: "skip", reason: "not-adversary" };
  if (identity.primary !== true) return { action: "skip", reason: "secondary-family-never-drives-the-loop" };
  const taskId = typeof input.taskId === "string" ? input.taskId.trim() : "";
  if (taskId) return { action: "skip", reason: "per-task-adversary-is-not-the-spec-loop" };

  const state = object(input.state);
  if (state.adversary_fired === true) return { action: "skip", reason: "spec adversary already accepted" };
  // Fail closed on absent evidence: without a recorded primary report there is nothing to accept,
  // and telling the orchestrator to stamp the ceremony marker off an empty state would forge the
  // very proof the marker exists to carry. Also covers the first round arriving malformed — that
  // has its own retry rail, and no useful report has landed yet.
  if (typeof state.primary_review_last_report_hash !== "string" || !state.primary_review_last_report_hash) {
    return { action: "skip", reason: "no recorded primary spec-adversary report to accept" };
  }

  const key = loopCounterKey(identity.canonicalName);
  if (key !== "adversary_loop_count") return { action: "skip", reason: "not-the-adversary-loop-counter" };
  const { deny } = thresholdsFor(key, object(input.overrides));
  const count = Number.isInteger(state[key]) && state[key] >= 0 ? state[key] : 0;
  const unresolved = state.primary_review_last_material_unresolved === true;
  const budgetSpent = count >= deny || BUDGET_SPENT_STATUSES.has(state.review_status);

  if (!unresolved) {
    return {
      action: "inject",
      kind: "accept",
      context:
        `[adversary-nudge] spec-adversary round ${count}/${deny} returned no unresolved material finding. ` +
        'This pass is ACCEPTED: call native `mark({ action: "adversary_fired" })` now, then dispatch `planner`. ' +
        "Do NOT re-attack the spec — another round cannot improve an accepted pass, and the planner stays " +
        "gated until that marker is stamped.",
    };
  }

  if (budgetSpent) {
    return {
      action: "inject",
      kind: "escalate",
      context:
        `[adversary-nudge] ${count} spec-adversary rounds and material findings are still open. This loop is not ` +
        "converging: each round rewrites the spec and the next round finds fresh surface, which can continue " +
        "indefinitely. STOP re-attacking — nothing refuses the dispatch, so stopping is YOUR call and this is it. " +
        "INTERACTIVE: stop and escalate to the operator in product language — list the residual findings as a " +
        "product decision (accept these risks and proceed, or change the spec) and WAIT for the answer. Do not " +
        "stamp the marker on your own judgement. HEADLESS: write the residual findings into spec.md under an " +
        'explicit "Open risks" heading, call native `mark({ action: "adversary_fired" })`, dispatch `planner` (the ' +
        "harness carries these findings into its brief automatically), and record them as open risks in the PR " +
        "body so the human gate on the PR sees them.",
    };
  }

  const remaining = deny - count;
  return {
    action: "inject",
    kind: "revise",
    context:
      `[adversary-nudge] spec-adversary round ${count}/${deny} left a material finding open. ` +
      "Next action: revise spec.md so the finding is answered — an acceptance criterion that pins the " +
      "behaviour, or an explicit locked decision that accepts it — then re-dispatch `adversary-family-1`. " +
      "Re-attacking WITHOUT changing spec.md wastes the round: the same spec yields the same class of finding. " +
      `${remaining} round(s) before this loop is treated as not converging, at which point you STOP and escalate ` +
      "to the operator instead of grinding out more rounds. Do not treat 'clean' as the only way out — an empty " +
      "issues array is not a realistic bar on a real codebase.",
  };
}

export default { decideAdversaryNudge };
