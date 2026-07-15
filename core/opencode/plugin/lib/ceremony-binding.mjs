/** @description Validate ceremony markers against the runtime session and classified feature. */

import { hasValidMarkerSeal, verifyMarker } from "./marker-seal.mjs";

export function ceremonyMarkerPatch(key, sessionId, featureId, seal) {
  return {
    [key]: true,
    [`${key}_binding`]: {
      session_id: sessionId,
      feature_id: featureId,
      operation: key,
      seal,
    },
  };
}

/** @description Fail closed for classified states whose identity or required marker binding differs. */
export function validateCeremonyBinding(gateState, { sessionId, featureId, required = [] } = {}) {
  const state = gateState && typeof gateState === "object" && !Array.isArray(gateState) ? gateState : {};
  const classifiedSession = typeof state.session_id === "string" ? state.session_id : "";
  const classifiedFeature = typeof state.feature_id === "string" ? state.feature_id : "";
  if (classifiedSession && classifiedSession !== sessionId) {
    return { ok: false, reason: `ceremony session binding mismatch: ${classifiedSession} != ${String(sessionId ?? "missing")}` };
  }
  if (featureId && classifiedFeature && classifiedFeature !== featureId) {
    return { ok: false, reason: `ceremony feature binding mismatch: ${classifiedFeature} != ${featureId}` };
  }
  for (const key of required) {
    if (state[key] !== true) continue;
    const binding = state[`${key}_binding`];
    if (
      !binding ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      binding.session_id !== sessionId ||
      binding.feature_id !== classifiedFeature ||
      binding.operation !== key ||
      !hasValidMarkerSeal(state, {
        sessionId,
        featureId: classifiedFeature,
        operation: key,
        payload: true,
      }) ||
      !verifyMarker({
        sessionId,
        featureId: classifiedFeature,
        operation: key,
        payload: true,
        seal: binding.seal,
      })
    ) {
      return { ok: false, reason: `${key} marker is not bound to current session and feature` };
    }
  }
  return { ok: true };
}

export default { ceremonyMarkerPatch, validateCeremonyBinding };
