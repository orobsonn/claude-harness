/**
 * @description Pure gate-state shape helpers for OC/CC shells.
 * dual_status enum (never bare boolean dual_completed); merge patch semantics;
 * marker array helpers. dual_status may be legacy scalar string (plan_review only)
 * or namespaced map { plan_review?, adversary? }. Never throws. No fs.
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
 * Dual axes (plan-review vs task-adversary). Plan dual must not satisfy adversary
 * precondition and vice-versa (#383).
 * @type {ReadonlyArray<"plan_review" | "adversary">}
 */
export const DUAL_STATUS_PHASES = Object.freeze(["plan_review", "adversary"]);

/** @type {ReadonlySet<string>} */
export const DUAL_STATUS_PHASE_SET = Object.freeze(new Set(DUAL_STATUS_PHASES));

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
 * @description True when value is a dual_status phase key.
 * @param {unknown} value
 * @returns {value is "plan_review" | "adversary"}
 */
export function isDualStatusPhase(value) {
  return typeof value === "string" && DUAL_STATUS_PHASE_SET.has(value);
}

/**
 * @description Map logical review role → dual_status phase axis.
 * plan-reviewer* → plan_review; adversary* → adversary; else undefined.
 * @param {unknown} logicalRole
 * @returns {"plan_review" | "adversary" | undefined}
 */
export function dualStatusPhaseFromRole(logicalRole) {
  if (typeof logicalRole !== "string") return undefined;
  const r = logicalRole.trim().toLowerCase();
  if (!r) return undefined;
  if (r === "plan-reviewer" || r.startsWith("plan-reviewer")) return "plan_review";
  if (r === "adversary" || r.startsWith("adversary")) return "adversary";
  return undefined;
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
 * @description True when value looks like a dual_status phase map (not array).
 * @param {unknown} value
 * @returns {boolean}
 */
export function isDualStatusMap(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @description Stable dual_status map for seal payloads (fixed phase key order).
 * Drops unknown keys and non-enum values.
 * @param {unknown} dualStatus
 * @returns {Record<string, string>}
 */
export function stableDualStatusMap(dualStatus) {
  /** @type {Record<string, string>} */
  const out = {};
  const map = normalizeDualStatusMap(dualStatus);
  for (const phase of DUAL_STATUS_PHASES) {
    if (typeof map[phase] === "string" && isDualStatusEnum(map[phase])) {
      out[phase] = map[phase];
    }
  }
  return out;
}

/**
 * @description Normalize dual_status field to a phase map.
 * Legacy scalar string → { plan_review: string } only (adversary still requires its own
 * axis — fail-closed for adversary path). Invalid values → {}.
 * @param {unknown} dualStatus
 * @returns {Record<string, string>}
 */
export function normalizeDualStatusMap(dualStatus) {
  try {
    if (typeof dualStatus === "string") {
      // Legacy scalar: plan_review only (never invent adversary coverage).
      return isDualStatusEnum(dualStatus) ? { plan_review: dualStatus } : {};
    }
    if (!isDualStatusMap(dualStatus)) return {};
    /** @type {Record<string, string>} */
    const out = {};
    const obj = /** @type {Record<string, unknown>} */ (dualStatus);
    for (const phase of DUAL_STATUS_PHASES) {
      const v = obj[phase];
      if (typeof v === "string" && isDualStatusEnum(v)) out[phase] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * @description Read dual_status for a phase from gate-state.
 * Legacy scalar string counts as plan_review only — adversary phase returns undefined.
 * Default phase is plan_review (executor path). Never throws.
 * @param {unknown} gateState
 * @param {"plan_review" | "adversary"} [phase="plan_review"]
 * @returns {string | undefined}
 */
export function readDualStatus(gateState, phase = "plan_review") {
  try {
    if (
      gateState == null ||
      typeof gateState !== "object" ||
      Array.isArray(gateState)
    ) {
      return undefined;
    }
    if (!isDualStatusPhase(phase)) return undefined;
    const raw = /** @type {Record<string, unknown>} */ (gateState).dual_status;
    if (typeof raw === "string") {
      // Legacy scalar → plan_review axis only.
      return phase === "plan_review" && isDualStatusEnum(raw) ? raw : undefined;
    }
    if (!isDualStatusMap(raw)) return undefined;
    const v = /** @type {Record<string, unknown>} */ (raw)[phase];
    return typeof v === "string" && isDualStatusEnum(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @description Gate-state patch fragment for dual_status (enum only). Never bare boolean.
 * Never invents secondary findings. Never writes dual_completed.
 * Without phase: legacy scalar `{ dual_status: status }` (compat).
 * With extra.phase: namespaced map `{ dual_status: { [phase]: status } }`.
 * Prefer dualStatusGatePatchForPhase for new writers.
 * @param {unknown} dualStatus
 * @param {{ errorClass?: string, secondaryAttempts?: number, phase?: "plan_review" | "adversary" }} [extra]
 * @returns {{ dual_status: string | Record<string, string>, dual_error_class?: string, dual_secondary_attempts?: number } | { ok: false, reason: string }}
 */
export function dualStatusGatePatch(dualStatus, extra = {}) {
  try {
    if (extra && extra.phase != null) {
      return dualStatusGatePatchForPhase(extra.phase, dualStatus, extra);
    }
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
 * @description Gate-state patch fragment for one dual_status phase (map form).
 * Never bare boolean. Never writes dual_completed.
 * @param {"plan_review" | "adversary" | unknown} phase
 * @param {unknown} dualStatus
 * @param {{ errorClass?: string, secondaryAttempts?: number }} [extra]
 * @returns {{ dual_status: Record<string, string>, dual_error_class?: string, dual_secondary_attempts?: number } | { ok: false, reason: string }}
 */
export function dualStatusGatePatchForPhase(phase, dualStatus, extra = {}) {
  try {
    if (!isDualStatusPhase(phase)) {
      return { ok: false, reason: `invalid dual_status phase: ${String(phase)}` };
    }
    if (typeof dualStatus === "boolean") {
      return {
        ok: false,
        reason: `invalid dual_status: bare boolean ${dualStatus} rejected (use enum)`,
      };
    }
    if (!isDualStatusEnum(dualStatus)) {
      return { ok: false, reason: `invalid dual_status: ${String(dualStatus)}` };
    }
    /** @type {{ dual_status: Record<string, string>, dual_error_class?: string, dual_secondary_attempts?: number }} */
    const patch = {
      dual_status: /** @type {Record<string, string>} */ ({ [phase]: dualStatus }),
    };
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
      reason:
        err instanceof Error ? err.message : "dualStatusGatePatchForPhase failed",
    };
  }
}

/**
 * @description Validate dual-related fields on a gate-state object.
 * Rejects bare boolean dual_completed and non-enum dual_status when present.
 * Accepts legacy scalar enum or map with plan_review/adversary keys each enum-or-absent.
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
      } else if (typeof s.dual_status === "string") {
        if (!isDualStatusEnum(s.dual_status)) {
          errors.push(`invalid dual_status: ${String(s.dual_status)}`);
        }
      } else if (isDualStatusMap(s.dual_status)) {
        const map = /** @type {Record<string, unknown>} */ (s.dual_status);
        for (const [key, value] of Object.entries(map)) {
          if (!isDualStatusPhase(key)) {
            errors.push(`unknown dual_status phase: ${key}`);
            continue;
          }
          if (value === undefined || value === null) continue;
          if (!isDualStatusEnum(value)) {
            errors.push(
              `invalid dual_status.${key}: ${String(value)}`,
            );
          }
        }
      } else {
        errors.push(
          "dual_status must be enum string or { plan_review?, adversary? } map",
        );
      }
    }

    if ("plan_verdict" in s && s.plan_verdict !== undefined) {
      if (typeof s.plan_verdict !== "string") {
        errors.push("plan_verdict must be APPROVE | REVISE");
      } else {
        const pv = s.plan_verdict.trim().toUpperCase();
        if (pv !== "APPROVE" && pv !== "REVISE") {
          errors.push(`invalid plan_verdict: ${String(s.plan_verdict)}`);
        }
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
 * dual_status only applied when accepted: scalar enum, or phase map (merged per axis).
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
        if (typeof value === "boolean") {
          return {
            ok: false,
            reason: `invalid dual_status: bare boolean ${value} rejected (use enum)`,
          };
        }
        if (typeof value === "string") {
          if (!isDualStatusEnum(value)) {
            return { ok: false, reason: `invalid dual_status: ${String(value)}` };
          }
          // Scalar patch: if prev is already a map, set plan_review axis only;
          // else keep legacy scalar (compat for dualStatusGatePatch without phase).
          if (isDualStatusMap(next.dual_status)) {
            next.dual_status = stableDualStatusMap({
              ...normalizeDualStatusMap(next.dual_status),
              plan_review: value,
            });
          } else {
            next.dual_status = value;
          }
          continue;
        }
        if (isDualStatusMap(value)) {
          const obj = /** @type {Record<string, unknown>} */ (value);
          for (const [phase, st] of Object.entries(obj)) {
            if (!isDualStatusPhase(phase)) {
              return { ok: false, reason: `unknown dual_status phase: ${phase}` };
            }
            if (st !== undefined && st !== null && !isDualStatusEnum(st)) {
              return {
                ok: false,
                reason: `invalid dual_status.${phase}: ${String(st)}`,
              };
            }
          }
          const merged = {
            ...normalizeDualStatusMap(next.dual_status),
            ...normalizeDualStatusMap(value),
          };
          next.dual_status = stableDualStatusMap(merged);
          continue;
        }
        return {
          ok: false,
          reason: `invalid dual_status: ${String(value)}`,
        };
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
