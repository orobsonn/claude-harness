/** @description Pure classify stub builder for pre-plan triage artifacts. Never throws. IO stays in OC tools / CC hooks. */

import { isSafeFeatureId, isSafeSessionId } from "./feature-id.mjs";

/** Valid triage modes (UPPERCASE vocabulary for stubs). */
export const CLASSIFY_MODES = new Set(["no-ceremony", "QUICK", "LIGHT", "FULL"]);

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
