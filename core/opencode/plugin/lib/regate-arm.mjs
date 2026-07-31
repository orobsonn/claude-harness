/**
 * @description Host-side regate-pending auto-arm after sniper-high/medium DONE.
 * Mirrors marker-authority regate-pending mutation (sealed entry) without Bash.
 * Fail-open on I/O / identity errors so after-hooks never break cleanup.
 */
import { bareRole } from "../../lib/roles.mjs";
import { withGateStateLock as defaultWithGateStateLock } from "../../lib/gate-state.mjs";
import { mergeGateStatePatch } from "../../../shared/lib/gate-state-shape.mjs";
import { gateStatePath as defaultGateStatePath } from "../../../shared/lib/path-helpers.mjs";
import { fidelityPassEntry } from "./mark-gate.mjs";

/**
 * @description True when role is sniper-high or sniper-medium (incl. -spawn twins).
 * v1 always arms high; medium is cheap and role-detectable.
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isRegateArmingSniperRole(subagentType) {
  const bare = bareRole(subagentType);
  if (!bare) return false;
  const base = bare.endsWith("-spawn") ? bare.slice(0, -"-spawn".length) : bare;
  return base === "sniper-high" || base === "sniper-medium";
}

/**
 * @description True when hand outcome should arm regate-pending (DONE only).
 * @param {unknown} outcome
 * @returns {boolean}
 */
export function isRegateArmingOutcome(outcome) {
  return outcome === "DONE";
}

/**
 * @description Append sealed regate_pending for feature/task under gate-state lock.
 * Idempotent when bare entry already present (re-seals same payload).
 * @param {{
 *   projectRoot: string,
 *   sessionId: string,
 *   featureId: string,
 *   taskId: string,
 *   gateStatePath?: (roots: { projectRoot: string, runtime: "opencode", sessionId: string }) =>
 *     { ok: true, path: string } | { ok: false, reason: string },
 *   withGateStateLock?: (
 *     statePath: string,
 *     fn: (prev: Record<string, unknown>) => Record<string, unknown> | { ok: false, reason: string },
 *   ) => { ok: true, state: Record<string, unknown> } | { ok: false, decision?: string, reason: string },
 * }} args
 * @returns {{ ok: true, state: Record<string, unknown>, entry: string } | { ok: false, reason: string }}
 */
export function armRegatePending({
  projectRoot,
  sessionId,
  featureId,
  taskId,
  gateStatePath = defaultGateStatePath,
  withGateStateLock = defaultWithGateStateLock,
} = {}) {
  try {
    if (typeof projectRoot !== "string" || !projectRoot) {
      return { ok: false, reason: "armRegatePending requires projectRoot" };
    }
    if (typeof sessionId !== "string" || !sessionId) {
      return { ok: false, reason: "armRegatePending requires sessionId" };
    }
    if (typeof featureId !== "string" || !featureId) {
      return { ok: false, reason: "armRegatePending requires featureId" };
    }
    if (typeof taskId !== "string" || !taskId) {
      return { ok: false, reason: "armRegatePending requires taskId" };
    }

    const gp = gateStatePath({ projectRoot, runtime: "opencode", sessionId });
    if (!gp || gp.ok !== true || typeof gp.path !== "string") {
      return { ok: false, reason: (gp && gp.reason) || "gateStatePath failed" };
    }

    const bare = fidelityPassEntry(featureId, taskId, null);

    const lockResult = withGateStateLock(gp.path, (previous) => {
      const prev =
        previous != null && typeof previous === "object" && !Array.isArray(previous)
          ? previous
          : {};
      if (prev.session_id !== sessionId || prev.feature_id !== featureId) {
        return { ok: false, reason: "gate-state identity mismatch for regate-pending arm" };
      }

      const patch = { regate_pending: [bare] };
      const applied = mergeGateStatePatch(prev, patch);
      if (!applied.ok) return applied;
      return applied.state;
    });

    if (!lockResult || lockResult.ok !== true) {
      return {
        ok: false,
        reason: (lockResult && lockResult.reason) || "withGateStateLock failed",
      };
    }
    return { ok: true, state: lockResult.state, entry: bare };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "armRegatePending failed",
    };
  }
}

export default { isRegateArmingSniperRole, isRegateArmingOutcome, armRegatePending };
