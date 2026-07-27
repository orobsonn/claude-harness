/**
 * @description Process-instance HMAC signing for dual/plan_verdict recording only (#484) —
 * nothing in the harness validates these seals anymore. Secret bytes never leave this module.
 */

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

/**
 * @description Create a persistable marker seal record without exposing secret bytes.
 * Kept for dual/plan_verdict recording (loop-decide.mjs, dual-nudge.mjs) — the per-process
 * HMAC signature is no longer read or validated anywhere (see docs/OC-CC-PARITY-REPORT.md
 * item #32 / issue #484): a fresh secret on every OpenCode restart made every marker sealed
 * before the restart permanently unverifiable, bricking delivery for any resumed session
 * (incident #423). `signMarker`/`sealedMarkerRecord` remain so existing dual/plan_verdict
 * recording call sites keep working unchanged; nothing validates the `seal` field anymore.
 */
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

export default { signMarker, sealedMarkerRecord };
