/** @description Pure loop-guard counters for plan-review and adversary. Never throws. Disk persistence is shell. */

import { bareRole } from "./roles.mjs";
import { reviewAgentIdentity } from "../../agents/review-catalog.mjs";

/** Defaults from resolved_judgments */
export const LOOP_THRESHOLDS = {
  plan_review: { warn: 2, deny: 4 },
  adversary: { warn: 2, deny: 4 },
};

/**
 * @typedef {{ ok: boolean, decision: "allow"|"deny"|"warn", reason: string, details?: unknown }} Decision
 */

/**
 * @description Which counter key a role increments, or null if not loop-guarded.
 * @param {unknown} subagentType
 * @returns {"plan_review_count"|"adversary_loop_count"|null}
 */
export function loopCounterKey(subagentType) {
  const identity = reviewAgentIdentity(subagentType);
  if (identity) {
    if (!identity.countsLoop) return null;
    if (identity.logicalRole === "plan-reviewer") return "plan_review_count";
    if (identity.logicalRole === "adversary") return "adversary_loop_count";
  }
  return null;
}

/**
 * @description Thresholds for a counter key.
 * @param {"plan_review_count"|"adversary_loop_count"} key
 * @param {{ planReviewWarn?: number, planReviewDeny?: number, adversaryWarn?: number, adversaryDeny?: number }} [overrides]
 */
export function thresholdsFor(key, overrides = {}) {
  if (key === "plan_review_count") {
    return {
      warn: overrides.planReviewWarn ?? LOOP_THRESHOLDS.plan_review.warn,
      deny: overrides.planReviewDeny ?? LOOP_THRESHOLDS.plan_review.deny,
    };
  }
  return {
    warn: overrides.adversaryWarn ?? LOOP_THRESHOLDS.adversary.warn,
    deny: overrides.adversaryDeny ?? LOOP_THRESHOLDS.adversary.deny,
  };
}

/**
 * @description After increment, decide allow / warn / deny for the next dispatch.
 * Count is the value AFTER this dispatch is counted.
 * @param {{
 *   subagentType?: unknown,
 *   count?: number,
 *   planReviewWarn?: number,
 *   planReviewDeny?: number,
 *   adversaryWarn?: number,
 *   adversaryDeny?: number,
 * }} input
 * @returns {Decision & { count?: number, counterKey?: string }}
 */
export function decideLoopGuard(input = {}) {
  try {
    const key = loopCounterKey(input.subagentType);
    if (!key) {
      return { ok: true, decision: "allow", reason: "not-loop-guarded" };
    }

    const count =
      typeof input.count === "number" && Number.isFinite(input.count)
        ? Math.max(0, Math.floor(input.count))
        : 0;

    const { warn, deny } = thresholdsFor(key, input);

    if (count >= deny) {
      return {
        ok: false,
        decision: "deny",
        reason: `[loop-guard] Blocked: ${key}=${count} reached deny threshold ${deny} for ${bareRole(input.subagentType)}.`,
        details: { counterKey: key, count, warn, deny },
        count,
        counterKey: key,
      };
    }

    if (count >= warn) {
      return {
        ok: true,
        decision: "warn",
        reason: `[loop-guard] Warning: ${key}=${count} reached warn threshold ${warn} for ${bareRole(input.subagentType)}.`,
        details: { counterKey: key, count, warn, deny },
        count,
        counterKey: key,
      };
    }

    return {
      ok: true,
      decision: "allow",
      reason: "loop-allow",
      details: { counterKey: key, count, warn, deny },
      count,
      counterKey: key,
    };
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: "[loop-guard] Blocked: loop decision failed",
    };
  }
}

/**
 * @description Next counter value after one dispatch of role.
 * @param {Record<string, unknown>} gateState
 * @param {unknown} subagentType
 * @returns {{ key: string, next: number } | null}
 */
export function nextLoopCount(gateState, subagentType) {
  const key = loopCounterKey(subagentType);
  if (!key) return null;
  const gs =
    gateState && typeof gateState === "object" && !Array.isArray(gateState)
      ? gateState
      : {};
  const prev =
    typeof gs[key] === "number" && Number.isInteger(gs[key]) ? /** @type {number} */ (gs[key]) : 0;
  return { key, next: prev + 1 };
}

/**
 * @param {Decision} decision
 * @returns {void}
 */
export function throwIfLoopDenied(decision) {
  if (decision && decision.decision === "deny") {
    throw new Error(decision.reason || "[loop-guard] denied");
  }
}
