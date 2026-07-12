/** @description Pure plan-gate decision: require full plan (expect full). Never throws. */

import { validatePlan } from "../../shared/lib/validate-plan.mjs";

/**
 * @typedef {{ ok: boolean, decision: "allow"|"deny"|"warn", reason: string, details?: unknown }} Decision
 */

/**
 * @description Deny stub kind or empty tasks when expect is full (plan-gate before executors).
 * @param {{ plan?: unknown, expect?: "full"|"stub"|"any" }} input
 * @returns {Decision}
 */
export function decidePlanGate(input = {}) {
  try {
    const expect = input.expect ?? "full";
    const plan = input.plan;

    if (plan === undefined || plan === null) {
      return {
        ok: false,
        decision: "deny",
        reason: "[plan-gate] Blocked: plan missing — full plan required before executor dispatch.",
      };
    }

    // Fast path: explicit stub kind or empty tasks under expect full
    if (expect === "full" && plan && typeof plan === "object" && !Array.isArray(plan)) {
      const p = /** @type {Record<string, unknown>} */ (plan);
      if (p.kind === "stub") {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[plan-gate] Blocked: plan is stub kind — planner must overwrite with full plan before executors.",
          details: { kind: "stub" },
        };
      }
      if (Array.isArray(p.tasks) && p.tasks.length === 0) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[plan-gate] Blocked: plan has empty tasks — expect full plan before executor dispatch.",
          details: { tasks: 0 },
        };
      }
    }

    const result = validatePlan(plan, { expect });
    if (!result.ok) {
      return {
        ok: false,
        decision: "deny",
        reason: `[plan-gate] Blocked: validatePlan(expect=${expect}) failed: ${result.errors.join("; ")}`,
        details: { errors: result.errors },
      };
    }

    return { ok: true, decision: "allow", reason: "plan-valid-full" };
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: "[plan-gate] Blocked: plan decision failed",
    };
  }
}

/**
 * @param {import("./entry-decide.mjs").Decision | Decision} decision
 * @returns {void}
 */
export function throwIfPlanDenied(decision) {
  if (decision && decision.decision === "deny") {
    throw new Error(decision.reason || "[plan-gate] denied");
  }
}
