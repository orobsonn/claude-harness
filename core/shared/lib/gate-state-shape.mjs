/** @description Pure gate-state shape helpers: patch merge, marker arrays, counters. No fs. Never throws. */

/** Marker array fields that merge by unique union (never drop on concurrent patch). */
export const MARKER_ARRAY_KEYS = new Set([
  "fidelity_pass",
  "hand_finished",
  "capture_verified",
  "regate_pending",
  "regate_passed",
  "hand_quarantine",
]);

/** Integer counter fields (absolute replace under lock after read). */
export const COUNTER_KEYS = new Set([
  "plan_review_count",
  "adversary_loop_count",
]);

/** Optional dual_status enum from 07 (when present). */
export const DUAL_STATUS_VALUES = new Set([
  "both",
  "primary_only_failopen",
  "pending",
  "primary_only_error",
]);

/**
 * @description Empty gate-state seed with optional overrides.
 * @param {Record<string, unknown>} [seed]
 * @returns {Record<string, unknown>}
 */
export function emptyGateState(seed = {}) {
  return {
    session_id: null,
    feature_id: null,
    mode: null,
    triaged: false,
    classified: false,
    brainstormed: false,
    adversary_fired: false,
    fidelity_pass: [],
    hand_finished: [],
    capture_verified: [],
    regate_pending: [],
    regate_passed: [],
    plan_review_count: 0,
    adversary_loop_count: 0,
    ...seed,
  };
}

/**
 * @description Union two arrays of string markers (order: prev then new unique).
 * @param {unknown} prev
 * @param {unknown} next
 * @returns {string[]}
 */
export function unionMarkers(prev, next) {
  const out = [];
  const seen = new Set();
  for (const arr of [prev, next]) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item !== "string" || item.length === 0) continue;
      if (seen.has(item)) continue;
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

/**
 * @description Compute next gate-state from prev + patch. Marker arrays union; counters replace;
 * other fields shallow-assign. Never throws.
 * @param {unknown} prev
 * @param {unknown} patch
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, reason: string }}
 */
export function applyGateStatePatch(prev, patch) {
  try {
    const base =
      prev && typeof prev === "object" && !Array.isArray(prev)
        ? /** @type {Record<string, unknown>} */ ({ ...prev })
        : {};
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      return { ok: false, reason: "invalid patch" };
    }
    const p = /** @type {Record<string, unknown>} */ (patch);
    for (const key of Object.keys(p)) {
      const val = p[key];
      if (MARKER_ARRAY_KEYS.has(key)) {
        base[key] = unionMarkers(base[key], val);
      } else if (COUNTER_KEYS.has(key)) {
        if (typeof val === "number" && Number.isFinite(val) && val >= 0) {
          base[key] = Math.floor(val);
        }
      } else {
        base[key] = val;
      }
    }
    return { ok: true, state: base };
  } catch {
    return { ok: false, reason: "applyGateStatePatch failed" };
  }
}

/**
 * @description Validate gate-state shape (markers arrays, counters non-negative ints, dual_status enum).
 * @param {unknown} state
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGateStateShape(state) {
  const errors = [];
  try {
    if (!state || typeof state !== "object" || Array.isArray(state)) {
      return { ok: false, errors: ["gate-state must be a non-null object"] };
    }
    const s = /** @type {Record<string, unknown>} */ (state);

    for (const key of MARKER_ARRAY_KEYS) {
      if (key in s && s[key] !== undefined && !Array.isArray(s[key])) {
        errors.push(`${key} must be an array when present`);
      } else if (Array.isArray(s[key])) {
        for (let i = 0; i < s[key].length; i++) {
          if (typeof s[key][i] !== "string") {
            errors.push(`${key}[${i}] must be string`);
          }
        }
      }
    }

    for (const key of COUNTER_KEYS) {
      if (key in s && s[key] !== undefined) {
        const n = s[key];
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
          errors.push(`${key} must be a non-negative integer`);
        }
      }
    }

    if ("dual_status" in s && s.dual_status !== undefined && s.dual_status !== null) {
      if (typeof s.dual_status !== "string" || !DUAL_STATUS_VALUES.has(s.dual_status)) {
        errors.push(
          `dual_status must be one of: ${[...DUAL_STATUS_VALUES].join("|")}`,
        );
      }
    }

    for (const flag of ["triaged", "classified", "brainstormed", "adversary_fired"]) {
      if (flag in s && s[flag] !== undefined && typeof s[flag] !== "boolean") {
        errors.push(`${flag} must be boolean when present`);
      }
    }
  } catch {
    errors.push("validateGateStateShape failed");
  }
  return { ok: errors.length === 0, errors };
}
