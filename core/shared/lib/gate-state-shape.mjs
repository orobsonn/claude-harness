/**
 * @description Pure gate-state shape helpers for OC/CC shells.
 * dual_status enum (never bare boolean dual_completed); merge patch semantics;
 * marker array helpers. Never throws. No fs.
 */

/** Locked dual_status enum (07-cross-family). Never store dual_completed: true. */
export const DUAL_STATUS = Object.freeze({
  BOTH: "both",
  PRIMARY_ONLY: "primary_only",
  PRIMARY_ONLY_FAILOPEN: "primary_only_failopen",
  PENDING: "pending",
  PRIMARY_ONLY_ERROR: "primary_only_error",
});

/** Closed set of dual_status values. */
export const DUAL_STATUS_VALUES = Object.freeze(
  new Set([
    DUAL_STATUS.BOTH,
    DUAL_STATUS.PRIMARY_ONLY,
    DUAL_STATUS.PRIMARY_ONLY_FAILOPEN,
    DUAL_STATUS.PENDING,
    DUAL_STATUS.PRIMARY_ONLY_ERROR,
  ]),
);

/**
 * Statuses that count as a recorded dual attempt (secondary was attempted or
 * auth-failopen recorded). `pending` and missing are NOT recorded attempts.
 */
export const RECORDED_DUAL_ATTEMPT_STATUSES = Object.freeze(
  new Set([
    DUAL_STATUS.BOTH,
    DUAL_STATUS.PRIMARY_ONLY,
    DUAL_STATUS.PRIMARY_ONLY_FAILOPEN,
    DUAL_STATUS.PRIMARY_ONLY_ERROR,
  ]),
);

/**
 * @description Whether dual_status counts as full cross-family coverage for metrics.
 * Only `both` is full dual; primary_only_failopen / primary_only_error / pending are not.
 * @param {unknown} dualStatus
 * @returns {boolean}
 */
export function isFullDualCoverage(dualStatus) {
  return dualStatus === DUAL_STATUS.BOTH;
}

/**
 * @description True when value is a valid dual_status enum member (not bare boolean).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDualStatusEnum(value) {
  return typeof value === "string" && DUAL_STATUS_VALUES.has(value);
}

/**
 * @description True when dual_status is a recorded attempt (not pending/missing).
 * @param {unknown} dualStatus
 * @returns {boolean}
 */
export function isRecordedDualAttempt(dualStatus) {
  return typeof dualStatus === "string" && RECORDED_DUAL_ATTEMPT_STATUSES.has(dualStatus);
}

/**
 * @description Gate-state patch fragment for dual_status (enum only). Never bare boolean.
 * Never invents secondary findings. Never writes dual_completed.
 * @param {unknown} dualStatus
 * @param {{ errorClass?: string, secondaryAttempts?: number }} [extra]
 * @returns {{ dual_status: string, dual_error_class?: string, dual_secondary_attempts?: number } | { ok: false, reason: string }}
 */
export function dualStatusGatePatch(dualStatus, extra = {}) {
  try {
    if (typeof dualStatus === "boolean") {
      return {
        ok: false,
        reason: `invalid dual_status: bare boolean ${dualStatus} rejected (use enum)`,
      };
    }
    if (!isDualStatusEnum(dualStatus)) {
      return { ok: false, reason: `invalid dual_status: ${String(dualStatus)}` };
    }
    /** @type {{ dual_status: string, dual_error_class?: string, dual_secondary_attempts?: number }} */
    const patch = { dual_status: dualStatus };
    if (extra && extra.errorClass != null) {
      patch.dual_error_class = String(extra.errorClass);
    }
    if (extra && extra.secondaryAttempts != null) {
      patch.dual_secondary_attempts = Number(extra.secondaryAttempts) || 0;
    }
    return patch;
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "dualStatusGatePatch failed",
    };
  }
}

/**
 * @description Validate dual-related fields on a gate-state object.
 * Rejects bare boolean dual_completed and non-enum dual_status when present.
 * Never throws.
 * @param {unknown} state
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGateStateDualFields(state) {
  const errors = [];
  try {
    if (state == null || typeof state !== "object" || Array.isArray(state)) {
      return { ok: false, errors: ["gate-state must be a plain object"] };
    }
    const s = /** @type {Record<string, unknown>} */ (state);

    // Bare boolean dual_completed is forbidden (07: never store dual_completed: true).
    if ("dual_completed" in s) {
      if (typeof s.dual_completed === "boolean") {
        errors.push(
          "dual_completed bare boolean rejected — use dual_status enum only",
        );
      } else {
        errors.push(
          "dual_completed field is forbidden — use dual_status enum only",
        );
      }
    }

    if ("dual_status" in s && s.dual_status !== undefined) {
      if (typeof s.dual_status === "boolean") {
        errors.push(
          `dual_status bare boolean ${s.dual_status} rejected — use enum`,
        );
      } else if (!isDualStatusEnum(s.dual_status)) {
        errors.push(`invalid dual_status: ${String(s.dual_status)}`);
      }
    }

    return { ok: errors.length === 0, errors };
  } catch (err) {
    return {
      ok: false,
      errors: [err instanceof Error ? err.message : "validateGateStateDualFields failed"],
    };
  }
}

/**
 * @description Pure merge of gate-state prev + patch. Never writes dual_completed.
 * dual_status only applied when dualStatusGatePatch accepts it.
 * Marker arrays are union-merged (dedup). Never throws.
 * @param {unknown} prev
 * @param {unknown} patch
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function mergeGateStatePatch(prev, patch) {
  try {
    const base =
      prev != null && typeof prev === "object" && !Array.isArray(prev)
        ? { .../** @type {Record<string, unknown>} */ (prev) }
        : {};
    if (patch == null || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: true, state: base };
    }
    const p = /** @type {Record<string, unknown>} */ (patch);

    // Forbid dual_completed in any patch.
    if ("dual_completed" in p) {
      return {
        ok: false,
        reason: "dual_completed bare boolean / field rejected — use dual_status enum",
      };
    }

    /** @type {Record<string, unknown>} */
    const next = { ...base };

    for (const [key, value] of Object.entries(p)) {
      if (key === "dual_status") {
        const statusPatch = dualStatusGatePatch(value);
        if ("ok" in statusPatch && statusPatch.ok === false) {
          return { ok: false, reason: statusPatch.reason };
        }
        next.dual_status = /** @type {{ dual_status: string }} */ (statusPatch).dual_status;
        continue;
      }
      if (key === "dual_error_class" || key === "dual_secondary_attempts") {
        next[key] = value;
        continue;
      }
      if (Array.isArray(value) && Array.isArray(next[key])) {
        const prevArr = /** @type {unknown[]} */ (next[key]);
        const merged = [...prevArr];
        for (const item of value) {
          if (!merged.includes(item)) merged.push(item);
        }
        next[key] = merged;
        continue;
      }
      next[key] = value;
    }

    const dualCheck = validateGateStateDualFields(next);
    if (!dualCheck.ok) {
      return { ok: false, reason: dualCheck.errors.join("; ") };
    }

    return { ok: true, state: next };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "mergeGateStatePatch failed",
    };
  }
}
