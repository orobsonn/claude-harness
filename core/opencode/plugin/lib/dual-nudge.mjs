/**
 * @description Pure, injectable-dependency dual-eye nudge computation for eligible
 * primary eyes (plan-reviewer, adversary). Compute-then-persist: builds the nudge
 * message string in memory, then performs ONE atomic withGateStateLock read-decide-write
 * to record dual_status + dual_nudge_attempts for the (featureId, taskId, phase) tuple —
 * never a separate readGateState guard followed by a separate write (TOCTOU). Mutating
 * `output` is the caller's responsibility (obs-eye.ts), strictly after a successful persist.
 * Never throws — any internal failure (seam throws OR seam denies) collapses to
 * { ok: false, reason }, mirroring the Result shape used across gate-state.mjs /
 * path-helpers.mjs.
 */
import { withGateStateLock as defaultWithGateStateLock } from "./gate-state.mjs";
import { gateStatePath as defaultGateStatePath } from "../../../shared/lib/path-helpers.mjs";
import { DUAL_STATUS } from "../../../shared/lib/gate-state-shape.mjs";
import { sealedMarkerRecord } from "./marker-seal.mjs";

/** Terminal dual_status values — never regressed back to pending (set membership, not `==='both'`). */
const TERMINAL_DUAL_STATUSES = new Set([
  DUAL_STATUS.BOTH,
  DUAL_STATUS.PRIMARY_ONLY,
  DUAL_STATUS.PRIMARY_ONLY_FAILOPEN,
  DUAL_STATUS.PRIMARY_ONLY_ERROR,
]);

/**
 * @description Dedupe key for dual_nudge_attempts — the FULL tuple, never role alone
 * (a later phase for the same feature/task/role must not be suppressed).
 * @param {string} featureId
 * @param {string} taskId
 * @param {string} phase
 * @returns {string}
 */
function escapeTuplePart(part) {
  return String(part).replace(/\\/g, "\\\\").replace(/\//g, "\\/");
}

export function dualNudgeTuple(featureId, taskId, phase) {
  return `${escapeTuplePart(featureId)}/${escapeTuplePart(taskId)}/${escapeTuplePart(phase)}`;
}

/**
 * @param {string} role
 * @param {string} tuple
 * @returns {string}
 */
export function buildDualNudgeMessage(role, tuple) {
  return `[dual-nudge] ${role} eligible for cross-family review — tuple ${tuple} recorded`;
}

/**
 * @description STEP 1 (COMPUTE) + STEP 2 (PERSIST). Builds the nudge message, then commits
 * dual_status/dual_nudge_attempts under a single withGateStateLock call. The read of the
 * current dual_status/dual_nudge_attempts and the conditional write happen INSIDE the same
 * lock callback (never a stale outer readGateState used as a guard). `pending` is only
 * writable when the current dual_status is absent or already `pending`; a disabled
 * secondary remains pending/skipped until primary accounting. Any terminal value
 * (both | primary_only | legacy fail-open statuses, checked via set membership) is
 * preserved as-is. The tuple is appended to dual_nudge_attempts only if not already present
 * (union-idempotent).
 * @param {{
 *   role: string,
 *   featureId: string,
 *   taskId: string,
 *   phase: string,
 *   sessionId: string,
 *   crossFamilyEnabled: boolean,
 *   gateStatePath?: () => { ok: true, path: string } | { ok: false, reason: string },
 *   withGateStateLock?: (
 *     statePath: string,
 *     fn: (prev: Record<string, unknown>) => Record<string, unknown> | { ok: false, reason: string },
 *   ) => { ok: true, state: Record<string, unknown> } | { ok: false, decision: "deny", reason: string },
 * }} args
 * @returns {{ ok: true, state: Record<string, unknown>, message: string } | { ok: false, reason: string }}
 */
export function applyDualNudge({
  role,
  featureId,
  taskId,
  phase,
  sessionId,
  crossFamilyEnabled,
  gateStatePath = defaultGateStatePath,
  withGateStateLock = defaultWithGateStateLock,
} = {}) {
  try {
    const tuple = dualNudgeTuple(featureId, taskId, phase);
    const message = buildDualNudgeMessage(role, tuple);

    const gp = gateStatePath();
    if (!gp || gp.ok !== true || typeof gp.path !== "string") {
      return { ok: false, reason: (gp && gp.reason) || "gateStatePath failed" };
    }

    const lockResult = withGateStateLock(gp.path, (prev) => {
      const base =
        prev != null && typeof prev === "object" && !Array.isArray(prev) ? prev : {};
      const rawStatus = base.dual_status;
      const isAbsent = rawStatus === undefined || rawStatus === null;
      const currentStatus = typeof rawStatus === "string" ? rawStatus : undefined;
      const currentAttempts = Array.isArray(base.dual_nudge_attempts)
        ? base.dual_nudge_attempts
        : [];

      let nextStatus;
      let secondaryStatus = base.dual_secondary_status;
      if (isAbsent || currentStatus === DUAL_STATUS.PENDING) {
        nextStatus = DUAL_STATUS.PENDING;
        secondaryStatus = crossFamilyEnabled ? "pending" : "skipped_disabled";
      } else if (currentStatus !== undefined && TERMINAL_DUAL_STATUSES.has(currentStatus)) {
        nextStatus = currentStatus;
      } else {
        return { ok: false, reason: `invalid dual_status: ${String(rawStatus)}` };
      }

      const nextAttempts = currentAttempts.includes(tuple)
        ? currentAttempts
        : [...currentAttempts, tuple];

      const next = { ...base, dual_status: nextStatus, dual_secondary_status: secondaryStatus, dual_nudge_attempts: nextAttempts };
      if (nextStatus === DUAL_STATUS.PENDING) {
        if (typeof sessionId !== "string" || !sessionId || typeof featureId !== "string" || !featureId) {
          return { ok: false, reason: "dual nudge requires session and feature identity" };
        }
        const seal = sealedMarkerRecord({ sessionId, featureId, operation: "dual", payload: nextStatus });
        const prior = Array.isArray(base.marker_seals) ? base.marker_seals : [];
        next.marker_seals = [...prior.filter((candidate) => candidate?.operation !== "dual"), seal];
      }
      return next;
    });

    if (!lockResult || lockResult.ok !== true) {
      return {
        ok: false,
        reason: (lockResult && lockResult.reason) || "withGateStateLock failed",
      };
    }

    return { ok: true, state: lockResult.state, message };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "applyDualNudge failed",
    };
  }
}
