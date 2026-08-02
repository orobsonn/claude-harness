/**
 * @description Pure real-file capture rail — dual-shape DONE (OC string + CC nested).
 * Inject listFn / isAncestorFn. No fs.
 */

/**
 * @param {unknown} v
 * @returns {unknown[]}
 */
function coerceArray(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * @param {unknown} record
 * @returns {boolean}
 */
export function isDoneHandRecord(record) {
  if (!record || typeof record !== "object") return false;
  const o = /** @type {Record<string, unknown>} */ (record).outcome;
  if (o === "DONE") return true;
  if (o && typeof o === "object" && !Array.isArray(o)) {
    return /** @type {Record<string, unknown>} */ (o).status === "DONE";
  }
  return false;
}

/**
 * @param {unknown} record
 * @returns {{ scope: unknown[], frozen: unknown[] }}
 */
export function recordViolations(record) {
  if (!record || typeof record !== "object") return { scope: [], frozen: [] };
  const r = /** @type {Record<string, unknown>} */ (record);
  const outcome =
    r.outcome && typeof r.outcome === "object" && !Array.isArray(r.outcome)
      ? /** @type {Record<string, unknown>} */ (r.outcome)
      : null;
  const scope = coerceArray(r.scopeViolations ?? outcome?.scopeViolations);
  const frozen = coerceArray(r.frozenViolations ?? outcome?.frozenViolations);
  return { scope, frozen };
}

/**
 * @param {unknown} stamp
 * @returns {boolean}
 */
export function isValidCapturedVerifiedAt(stamp) {
  return typeof stamp === "string" && stamp.length > 0;
}

/**
 * @param {string} featureId
 * @param {{
 *   listHandRecordsForFeatureFn?: (featureId: string) => Array<{ taskId: string, record?: unknown, sessionId?: string }>,
 *   isAncestorFn?: (sha: string) => boolean|null,
 *   requireCaptureEvidence?: boolean,
 *   requiredSessionId?: string,
 * }} deps
 * @returns {null | { decision: "deny", ok: false, reason: string }}
 */
export function checkRealFileCaptureRail(featureId, deps = {}) {
  const listFn = deps.listHandRecordsForFeatureFn;
  const isAncestorFn = deps.isAncestorFn;
  const requireCaptureEvidence = deps.requireCaptureEvidence === true;
  const requiredSessionId =
    typeof deps.requiredSessionId === "string" && deps.requiredSessionId.length > 0
      ? deps.requiredSessionId
      : null;
  if (typeof listFn !== "function") {
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: real-file-list-unavailable — listHandRecordsForFeatureFn required for delivery.",
    };
  }
  if (typeof isAncestorFn !== "function") {
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: real-file-list-unavailable — isAncestorFn required for delivery.",
    };
  }

  let records;
  try {
    records = listFn(featureId);
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: real-file-list-unavailable — listHandRecordsForFeatureFn threw.",
    };
  }
  if (!Array.isArray(records)) {
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: real-file-list-unavailable — listHandRecordsForFeatureFn must return an array.",
    };
  }

  /** @type {boolean} at least one DONE+stamp+ancestor (+ session match when required) */
  let hasCaptureEvidence = false;

  for (const item of records) {
    if (!item || typeof item !== "object") continue;
    const taskId = /** @type {{ taskId?: string }} */ (item).taskId ?? "unknown";
    const identityError = /** @type {{ identityError?: unknown }} */ (item).identityError;
    if (typeof identityError === "string" && identityError.length > 0) {
      return {
        ok: false,
        decision: "deny",
        reason: `[entry-gate] Blocked: hand-record identity mismatch for ${featureId}/${taskId} — ${identityError}.`,
      };
    }
    const itemSessionId =
      typeof /** @type {{ sessionId?: unknown }} */ (item).sessionId === "string"
        ? /** @type {{ sessionId: string }} */ (item).sessionId
        : null;
    const record = /** @type {{ record?: unknown }} */ (item).record;
    if (!record || typeof record !== "object") continue;
    const r = /** @type {Record<string, unknown>} */ (record);
    const sha = r.freezeCommitSha;

    if (isDoneHandRecord(record)) {
      if (typeof sha !== "string" || sha.length === 0) {
        return {
          ok: false,
          decision: "deny",
          reason:
            `[entry-gate] Blocked: the on-disk run-record for ${featureId}/${taskId} shows a ` +
            "completed dispatch with unresolved-freeze (freezeCommitSha missing/empty).",
        };
      }
    }

    if (typeof sha !== "string" || sha.length === 0) continue;

    let ancestor = null;
    try {
      ancestor = isAncestorFn(sha);
    } catch {
      ancestor = null;
    }
    // false = abandoned/unrelated lineage → skip fail-open
    if (ancestor === false) continue;

    const { scope, frozen } = recordViolations(record);
    const isDone = isDoneHandRecord(record);
    const hasViolations = scope.length > 0 || frozen.length > 0;

    // null (or non-boolean) = undetermined → deny fail-closed for DONE or scope/frozen
    if (ancestor !== true) {
      if (isDone || hasViolations) {
        return {
          ok: false,
          decision: "deny",
          reason:
            `[entry-gate] Blocked: ancestor-undetermined for ${featureId}/${taskId} ` +
            `(freezeCommitSha=${sha}) — cannot confirm lineage; resolve git ancestry before delivery.`,
        };
      }
      continue;
    }

    if (hasViolations) {
      return {
        ok: false,
        decision: "deny",
        reason:
          `[entry-gate] Blocked: the independent capture for ${featureId}/${taskId} found a ` +
          `SCOPE/FROZEN-MANIFEST violation (${[...scope, ...frozen].join(", ")}). ` +
          "This requires a human decision, not a re-run or a capture-verified stamp — resolve " +
          "the out-of-scope write (revert it or fold it into scope_paths deliberately) before proceeding.",
      };
    }

    if (isDone && !isValidCapturedVerifiedAt(r.capturedVerifiedAt)) {
      return {
        ok: false,
        decision: "deny",
        reason:
          `[entry-gate] Blocked: the on-disk run-record for ${featureId}/${taskId} shows a ` +
          "completed dispatch with no independent capture stamped on it yet " +
          "(capturedVerifiedAt missing), regardless of what hand_finished/capture_verified show. " +
          "Run capture-hand.mjs and stamp capture-verified before proceeding.",
      };
    }

    // Positive evidence: DONE + valid stamp + ancestor + no violations
    // When requiredSessionId set, only the current delivery session counts
    if (
      isDone &&
      isValidCapturedVerifiedAt(r.capturedVerifiedAt) &&
      (!requiredSessionId || itemSessionId === requiredSessionId)
    ) {
      hasCaptureEvidence = true;
    }
  }

  if (requireCaptureEvidence && !hasCaptureEvidence) {
    return {
      ok: false,
      decision: "deny",
      reason:
        "[entry-gate] Blocked: real-file-no-capture-evidence — LIGHT/FULL delivery requires at least one on-disk hand-record for the feature" +
        (requiredSessionId
          ? ` in the current session (${requiredSessionId})`
          : "") +
        " with DONE + capturedVerifiedAt (empty list or other-session-only is a vacuous ship).",
    };
  }

  return null;
}
