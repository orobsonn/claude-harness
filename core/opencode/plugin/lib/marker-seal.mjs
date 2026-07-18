/** @description Process-instance HMAC seals for privileged marker semantics. Secret bytes never leave this module. */

import crypto from "node:crypto";

const DOMAIN = "claude-harness/opencode-marker-seal/v1";
const secret = crypto.randomBytes(32);

function field(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `${Buffer.byteLength(text, "utf8")}:${text}`;
}

function message({ sessionId, featureId, operation, payload }) {
  return [DOMAIN, sessionId, featureId, operation, payload].map(field).join("|");
}

/** @description Sign one marker binding with this process instance. */
export function signMarker({ sessionId, featureId, operation, payload }) {
  if (![sessionId, featureId, operation].every((value) => typeof value === "string" && value.length > 0)) {
    throw new Error("marker seal requires sessionId, featureId, and operation");
  }
  return crypto.createHmac("sha256", secret).update(message({ sessionId, featureId, operation, payload })).digest("base64url");
}

/** @description Timing-safe verification against this process instance only. */
export function verifyMarker({ sessionId, featureId, operation, payload, seal }) {
  if (typeof seal !== "string" || seal.length === 0) return false;
  try {
    const expected = Buffer.from(signMarker({ sessionId, featureId, operation, payload }), "base64url");
    const actual = Buffer.from(seal, "base64url");
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/** @description Create a persistable marker seal record without exposing secret bytes. */
export function sealedMarkerRecord({ sessionId, featureId, operation, payload }) {
  return {
    version: 1,
    session_id: sessionId,
    feature_id: featureId,
    operation,
    payload,
    seal: signMarker({ sessionId, featureId, operation, payload }),
  };
}

/** @description True when state contains this exact marker sealed by the current process. */
export function hasValidMarkerSeal(state, { sessionId, featureId, operation, payload }) {
  if (!state || typeof state !== "object" || !Array.isArray(state.marker_seals)) return false;
  return state.marker_seals.some((record) =>
    record &&
    typeof record === "object" &&
    record.version === 1 &&
    record.session_id === sessionId &&
    record.feature_id === featureId &&
    record.operation === operation &&
    JSON.stringify(record.payload) === JSON.stringify(payload) &&
    verifyMarker({ sessionId, featureId, operation, payload, seal: record.seal }),
  );
}

/** @description Reject every present privileged marker not sealed by this process instance. */
export function validatePrivilegedMarkerSeals(state, { sessionId, featureId }) {
  const value = state && typeof state === "object" && !Array.isArray(state) ? state : {};
  const checks = [];
  if (value.brainstormed === true) checks.push(["brainstormed", true]);
  if (value.adversary_fired === true) checks.push(["adversary_fired", true]);
  if (value.final_review_done === true) checks.push(["final-review", true]);
  if (value.demo_done === true) checks.push(["demo-done", true]);
  if (typeof value.dual_status === "string") {
    checks.push(["dual", value.dual_status]);
  } else if (value.dual_status && typeof value.dual_status === "object" && !Array.isArray(value.dual_status)) {
    // Map form: seal payload is the stable phase map written by dualState / dual-nudge.
    const stable = {};
    for (const phase of ["plan_review", "adversary"]) {
      const st = value.dual_status[phase];
      if (typeof st === "string") stable[phase] = st;
    }
    if (Object.keys(stable).length > 0) checks.push(["dual", stable]);
  }
  if (typeof value.plan_verdict === "string" && value.plan_verdict.length > 0) {
    checks.push(["plan_verdict", value.plan_verdict]);
  }
  for (const [key, operation] of [
    ["fidelity_pass", "fidelity"],
    ["regate_pending", "regate-pending"],
    ["regate_passed", "regate-passed"],
    ["hand_finished", "hand-finished"],
    ["capture_verified", "capture-verified"],
  ]) {
    if (!Array.isArray(value[key])) continue;
    for (const payload of value[key]) checks.push([operation, payload]);
  }
  for (const [operation, payload] of checks) {
    if (!hasValidMarkerSeal(value, { sessionId, featureId, operation, payload })) {
      return { ok: false, reason: `${operation} marker is unsigned or sealed by another process instance` };
    }
  }
  return { ok: true };
}

export default { signMarker, verifyMarker, sealedMarkerRecord, hasValidMarkerSeal, validatePrivilegedMarkerSeals };
