/** @description Pure classify stub builder for pre-plan triage artifacts. Never throws. IO stays in OC tools / CC hooks. */

import { isSafeFeatureId, isSafeSessionId } from "./feature-id.mjs";

/** Valid triage modes (UPPERCASE vocabulary for stubs). */
export const CLASSIFY_MODES = new Set(["no-ceremony", "QUICK", "LIGHT", "FULL"]);

/** @description Monotonic rank — escalate only (no-ceremony < QUICK < LIGHT < FULL). */
export const MODE_RANK = Object.freeze({
  "no-ceremony": 0,
  QUICK: 1,
  LIGHT: 2,
  FULL: 3,
});

/**
 * @description Pure classify transition. Replay same session+feature+mode is no-op;
 * same feature may only escalate; downgrade and feature-switch are denied once classified.
 * @param {{
 *   requestedMode?: unknown,
 *   requestedFeatureId?: unknown,
 *   currentMode?: unknown,
 *   currentFeatureId?: unknown,
 *   classified?: unknown,
 * }} input
 * @returns {{
 *   ok: true,
 *   action: "fresh" | "noop" | "escalate",
 *   mode: string,
 *   featureId: string,
 *   peakMode: string,
 * } | { ok: false, reason: string }}
 */
export function decideClassifyTransition(input = {}) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, reason: "invalid input" };
    }
    const requestedMode = typeof input.requestedMode === "string" ? input.requestedMode.trim() : "";
    const requestedFeatureId =
      typeof input.requestedFeatureId === "string"
        ? input.requestedFeatureId.trim()
        : typeof input.feature_id === "string"
          ? input.feature_id.trim()
          : "";
    if (!CLASSIFY_MODES.has(requestedMode)) return { ok: false, reason: "invalid mode" };
    if (!isSafeFeatureId(requestedFeatureId)) return { ok: false, reason: "invalid featureId" };

    const classified = input.classified === true;
    const currentMode = typeof input.currentMode === "string" ? input.currentMode.trim() : "";
    const currentFeatureId =
      typeof input.currentFeatureId === "string" ? input.currentFeatureId.trim() : "";
    const peakRaw = typeof input.peakMode === "string" ? input.peakMode.trim() : "";
    const peakBase =
      CLASSIFY_MODES.has(peakRaw) ? peakRaw : CLASSIFY_MODES.has(currentMode) ? currentMode : requestedMode;

    if (!classified || !CLASSIFY_MODES.has(currentMode) || !isSafeFeatureId(currentFeatureId)) {
      return {
        ok: true,
        action: "fresh",
        mode: requestedMode,
        featureId: requestedFeatureId,
        peakMode: rankMax(peakBase, requestedMode),
      };
    }

    if (requestedFeatureId !== currentFeatureId) {
      return {
        ok: false,
        reason: "feature switch denied — start a new session for a different feature_id",
      };
    }

    const curRank = MODE_RANK[currentMode];
    const reqRank = MODE_RANK[requestedMode];
    if (reqRank === curRank) {
      return {
        ok: true,
        action: "noop",
        mode: currentMode,
        featureId: currentFeatureId,
        peakMode: rankMax(peakBase, currentMode),
      };
    }
    if (reqRank < curRank) {
      return {
        ok: false,
        reason: `downgrade denied — mode is ${currentMode}; cannot reclassify to ${requestedMode}`,
      };
    }
    return {
      ok: true,
      action: "escalate",
      mode: requestedMode,
      featureId: currentFeatureId,
      peakMode: rankMax(peakBase, requestedMode),
    };
  } catch {
    return { ok: false, reason: "decideClassifyTransition failed" };
  }
}

/** @param {string} a @param {string} b */
function rankMax(a, b) {
  const ra = MODE_RANK[a] ?? -1;
  const rb = MODE_RANK[b] ?? -1;
  return rb >= ra ? b : a;
}

/**
 * @description Builds a validated pre-plan stub object (kind: stub, empty tasks).
 * Does not write to disk. featureId must be safe kebab-case; sessionId when provided must be safe.
 * @param {{ mode?: unknown, featureId?: unknown, sessionId?: unknown }} input
 * @returns {{ ok: true, stub: object } | { ok: false, reason: string }}
 */
export function buildClassifyStub(input = {}) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, reason: "invalid input" };
    }

    const mode = typeof input.mode === "string" ? input.mode.trim() : "";
    const featureId =
      typeof input.featureId === "string"
        ? input.featureId.trim()
        : typeof input.feature_id === "string"
          ? input.feature_id.trim()
          : "";
    const sessionId =
      typeof input.sessionId === "string"
        ? input.sessionId.trim()
        : typeof input.session_id === "string"
          ? input.session_id.trim()
          : undefined;

    if (!isSafeFeatureId(featureId)) {
      return { ok: false, reason: "invalid featureId" };
    }
    if (!CLASSIFY_MODES.has(mode)) {
      return { ok: false, reason: "invalid mode" };
    }
    if (sessionId !== undefined && sessionId !== "" && !isSafeSessionId(sessionId)) {
      return { ok: false, reason: "invalid sessionId" };
    }

    /** @type {Record<string, unknown>} */
    const stub = {
      kind: "stub",
      mode,
      feature_id: featureId,
      tasks: [],
    };
    if (sessionId) {
      stub.session_id = sessionId;
    }

    return { ok: true, stub };
  } catch {
    return { ok: false, reason: "buildClassifyStub failed" };
  }
}
