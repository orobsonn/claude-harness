/** @description Pure OC gate-state shape helpers with tolerant legacy review-status reads. */

export const DUAL_STATUS = Object.freeze({
  DONE: "done",
  PENDING: "pending",
});

export const DUAL_STATUS_VALUES = Object.freeze(new Set(Object.values(DUAL_STATUS)));

const LEGACY_DONE_STATUSES = new Set(["both", "primary_only", "primary_only_failopen", "primary_only_error"]);
const LEGACY_PENDING_STATUSES = new Set(["pending"]);
const LEGACY_PHASES = new Set(["plan_review", "adversary"]);

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** @description True only for the single-evaluator enum written by current OC code. */
export function isDualStatusEnum(value) {
  return typeof value === "string" && DUAL_STATUS_VALUES.has(value);
}

function normalizeStatusValue(value) {
  if (value === DUAL_STATUS.DONE || LEGACY_DONE_STATUSES.has(value)) return DUAL_STATUS.DONE;
  if (value === DUAL_STATUS.PENDING || LEGACY_PENDING_STATUSES.has(value)) return DUAL_STATUS.PENDING;
  return undefined;
}

/**
 * @description Normalize current scalar state and persisted dual-family scalar/map state.
 * Persisted maps retain the old lifecycle decision: only scalar pending/error blocked retention.
 */
export function normalizeDualStatus(value) {
  try {
    // The old lifecycle blocked this scalar explicitly. Its map form was not blocked.
    if (value === "primary_only_error") return DUAL_STATUS.PENDING;
    if (typeof value === "string") return normalizeStatusValue(value);
    if (!isObject(value)) return undefined;
    let sawDone = false;
    for (const [phase, status] of Object.entries(value)) {
      if (!LEGACY_PHASES.has(phase)) return undefined;
      if (status == null) continue;
      const normalized = normalizeStatusValue(status);
      if (!normalized) return undefined;
      sawDone = true;
    }
    return sawDone ? DUAL_STATUS.DONE : undefined;
  } catch {
    return undefined;
  }
}

/** @description Read current or legacy persisted dual_status without throwing. */
export function readDualStatus(gateState) {
  if (!isObject(gateState)) return undefined;
  return normalizeDualStatus(gateState.dual_status);
}

/** @description Build a current single-evaluator dual_status patch. */
export function dualStatusGatePatch(status) {
  if (!isDualStatusEnum(status)) {
    return { ok: false, reason: `invalid dual_status: ${String(status)}` };
  }
  return { dual_status: status };
}

/** @description Validate current fields while accepting legacy persisted dual_status shapes. */
export function validateGateStateDualFields(state) {
  const errors = [];
  try {
    if (!isObject(state)) return { ok: false, errors: ["gate-state must be a plain object"] };
    if ("dual_completed" in state) {
      errors.push("dual_completed field is forbidden — use dual_status enum only");
    }
    if ("dual_status" in state && state.dual_status !== undefined && !normalizeDualStatus(state.dual_status)) {
      errors.push("dual_status must be done | pending or a recognized persisted legacy value");
    }
    if ("plan_verdict" in state && state.plan_verdict !== undefined) {
      if (typeof state.plan_verdict !== "string" || !["APPROVE", "REVISE"].includes(state.plan_verdict.trim().toUpperCase())) {
        errors.push("plan_verdict must be APPROVE | REVISE");
      }
    }
    return { ok: errors.length === 0, errors };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : "gate-state validation failed"] };
  }
}

/**
 * @description Pure patch merge. Existing legacy fields are carried untouched by unrelated
 * patches; any new dual_status write must use the current single-evaluator enum.
 */
export function mergeGateStatePatch(previous, patch) {
  try {
    const base = isObject(previous) ? { ...previous } : {};
    if (!isObject(patch)) return { ok: true, state: base };
    if ("dual_completed" in patch) {
      return { ok: false, reason: "dual_completed field rejected — use dual_status enum" };
    }
    const next = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "dual_status") {
        if (!isDualStatusEnum(value)) {
          return { ok: false, reason: `invalid dual_status: ${String(value)}` };
        }
        next.dual_status = value;
        continue;
      }
      if (key === "plan_verdict") {
        if (typeof value !== "string" || !["APPROVE", "REVISE"].includes(value.trim().toUpperCase())) {
          return { ok: false, reason: `invalid plan_verdict: ${String(value)}` };
        }
        next.plan_verdict = value;
        continue;
      }
      if (Array.isArray(value) && Array.isArray(next[key])) {
        const merged = [...next[key]];
        for (const item of value) {
          if (!merged.includes(item)) merged.push(item);
        }
        next[key] = merged;
        continue;
      }
      next[key] = value;
    }
    return { ok: true, state: next };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "mergeGateStatePatch failed" };
  }
}
