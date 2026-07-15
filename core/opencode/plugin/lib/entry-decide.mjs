/** @description Pure entry-gate decisions for OC (ceremony + fidelity). Never throws; returns Decision. */

import {
  bareRole,
  isDeliveryRole,
  isExecutorRole,
  isSniperRole,
  isPlannerRole,
  isTestAuthorRole,
  isAdversaryRole,
  isQuickCeremonyBlockedRole,
} from "./roles.mjs";

/**
 * @typedef {{ ok: boolean, decision: "allow"|"deny"|"warn", reason: string, details?: unknown }} Decision
 */

/**
 * @description Whether fidelity_pass contains an entry for feature/task (prefix match, optional @sha).
 * @param {unknown} fidelityPass
 * @param {string} featureId
 * @param {string} [taskId]
 * @returns {boolean}
 */
export function hasFidelityPass(fidelityPass, featureId, taskId) {
  if (!Array.isArray(fidelityPass) || typeof featureId !== "string" || !featureId) {
    return false;
  }
  for (const entry of fidelityPass) {
    if (typeof entry !== "string") continue;
    const at = entry.lastIndexOf("@");
    const base = at > 0 ? entry.slice(0, at) : entry;
    if (typeof taskId === "string" && taskId.length > 0) {
      const qualified = `${featureId}/${taskId}`;
      if (base === qualified) return true;
    } else if (base === featureId || base.startsWith(`${featureId}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * @description Decide whether a task subagent dispatch is allowed.
 * Ceremony: delivery roles need classified/triaged markers (or mode stamped by classify).
 * Planner: brainstormed + adversary_fired.
 * Fidelity: executor + sniper blocked until fidelity_pass; test-author always exempt.
 * @param {{
 *   subagentType?: unknown,
 *   gateState?: unknown,
 *   mode?: unknown,
 *   featureId?: unknown,
 *   taskId?: unknown,
 * }} input
 * @returns {Decision}
 */
export function decideEntryTask(input = {}) {
  try {
    const sub = bareRole(input.subagentType);
    if (!sub || !isDeliveryRole(sub)) {
      return { ok: true, decision: "allow", reason: "non-delivery-role" };
    }

    const gs =
      input.gateState && typeof input.gateState === "object" && !Array.isArray(input.gateState)
        ? /** @type {Record<string, unknown>} */ (input.gateState)
        : {};

    const classified = gs.classified === true || gs.triaged === true;
    const hasModeStamp =
      typeof gs.mode === "string" &&
      ["no-ceremony", "QUICK", "LIGHT", "FULL", "light", "full", "quick"].includes(gs.mode);

    // Ceremony missing: no classify/triage stamp at all
    if (!classified && !hasModeStamp) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "[entry-gate] Blocked: ceremony missing — run triaging-requests and classify before dispatching delivery agents.",
      };
    }

    // QUICK/no-ceremony backstop: block the four roles (compliance etc); executor exempt
    const modeNorm = String(gs.mode || "").trim().toLowerCase();
    if ((modeNorm === "quick" || modeNorm === "no-ceremony") && isQuickCeremonyBlockedRole(sub)) {
      return {
        ok: false,
        decision: "deny",
        reason: `[entry-gate] Blocked: ${modeNorm} forbids ${sub} (compliance/security/harvester/shipper require LIGHT/FULL).`,
      };
    }

    // Planner ceremony: brainstormed + adversary_fired
    if (isPlannerRole(sub)) {
      if (gs.brainstormed !== true) {
        return {
          ok: false,
          decision: "deny",
          reason: JSON.stringify({ code: "CEREMONY_PROOF_REQUIRED", missing_proof: "brainstorming_completion_evidence", next_transition: { phase: "brainstorming", action: "resume", marker: "brainstormed" } }),
        };
      }
      if (gs.adversary_fired !== true) {
        return {
          ok: false,
          decision: "deny",
          reason: JSON.stringify({ code: "CEREMONY_PROOF_REQUIRED", missing_proof: "spec_adversary_completion_evidence", next_transition: { phase: "spec-adversary", action: "resume", marker: "adversary_fired" } }),
        };
      }
    }

    // Adversary dispatch is allowed once ceremony is present (caller stamps adversary_fired)
    if (isAdversaryRole(sub)) {
      return { ok: true, decision: "allow", reason: "adversary-allowed" };
    }

    // Fidelity rail: test-author EXEMPT; executor + sniper blocked until pass
    if (isTestAuthorRole(sub)) {
      return { ok: true, decision: "allow", reason: "test-author-fidelity-exempt" };
    }

    if (isExecutorRole(sub) || isSniperRole(sub)) {
      const featureId =
        typeof input.featureId === "string"
          ? input.featureId
          : typeof gs.feature_id === "string"
            ? gs.feature_id
            : "";
      const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
      if (!hasFidelityPass(gs.fidelity_pass, featureId, taskId)) {
        const roleLabel = isSniperRole(sub) ? "sniper" : "executor";
        return {
          ok: false,
          decision: "deny",
          reason: `[entry-gate] Blocked: ${roleLabel} requires fidelity-pass for the task before spawn; dispatch test-author first.`,
          details: { featureId, taskId },
        };
      }
    }

    return { ok: true, decision: "allow", reason: "entry-allow" };
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: "[entry-gate] Blocked: entry decision failed",
    };
  }
}

/**
 * @description Map Decision to throw for OC plugin (fail-closed).
 * @param {Decision} decision
 * @returns {void}
 * @throws {Error} when decision is deny
 */
export function throwIfDenied(decision) {
  if (decision && decision.decision === "deny") {
    throw new Error(decision.reason || "[entry-gate] denied");
  }
}
