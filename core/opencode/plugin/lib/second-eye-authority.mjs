/** @description Process-bound authority for signed refute dispatches and one-shot prepared state. */

import crypto from "node:crypto";
import {
  REFUTE_PASS_BUDGET,
  REFUTE_PASS_MARKER,
  REFUTE_PASS_MARKER_CLOSE,
} from "../../skills/orchestrating-delivery/second-eye-runtime.mjs";

const secret = crypto.randomBytes(32);
const preparedById = new Map();
const secondaryByCall = new Map();

function payloadText(payload) {
  return JSON.stringify({
    version: 1,
    adjudication_id: payload.adjudication_id,
    refute_id: payload.refute_id,
    role: payload.role,
    session_id: payload.session_id,
    feature_id: payload.feature_id,
    epoch: payload.epoch,
    primary_report_hash: payload.primary_report_hash,
    brief_hash: payload.brief_hash,
  });
}

function signature(payload) {
  return crypto.createHmac("sha256", secret).update(payloadText(payload)).digest("hex");
}

function markerEnvelope(prompt) {
  if (typeof prompt !== "string" || !prompt.endsWith(REFUTE_PASS_MARKER_CLOSE)) return null;
  if (
    prompt.split(REFUTE_PASS_MARKER).length - 1 !== 1 ||
    prompt.split(REFUTE_PASS_MARKER_CLOSE).length - 1 !== 1
  ) return null;
  const end = prompt.length - REFUTE_PASS_MARKER_CLOSE.length;
  const markerStart = prompt.lastIndexOf(REFUTE_PASS_MARKER, end);
  if (markerStart < 0) return null;
  try {
    const value = JSON.parse(prompt.slice(markerStart + REFUTE_PASS_MARKER.length, end));
    return value && typeof value === "object" && !Array.isArray(value) ? { payload: value, markerStart } : null;
  } catch {
    return null;
  }
}

export function hasRefutePassMarker(prompt) {
  return typeof prompt === "string" && (prompt.includes(REFUTE_PASS_MARKER) || prompt.includes(REFUTE_PASS_MARKER_CLOSE));
}

/** @description Sign a prepared descriptor and retain its untampered state for one finalization. */
export function sealPreparedAdjudication(prepared, { sessionId } = {}) {
  if (!prepared || prepared.action !== "dispatch-refute" || typeof sessionId !== "string" || !sessionId) return prepared;
  const adjudicationId = crypto.randomUUID();
  const markerStart = prepared.refute_dispatch.prompt.lastIndexOf(REFUTE_PASS_MARKER);
  if (markerStart < 0) return prepared;
  const context = prepared.adjudication_context ?? {};
  const payload = {
    version: 1,
    adjudication_id: adjudicationId,
    refute_id: prepared.refute_pass_id,
    role: prepared.role,
    session_id: sessionId,
    feature_id: context.feature_id,
    epoch: context.epoch,
    primary_report_hash: context.primary_report_hash,
    brief_hash: hashBrief(prepared.refute_dispatch.prompt.slice(0, markerStart)),
  };
  const signed = { ...payload, signature: signature(payload) };
  const prompt = markerStart < 0
    ? prepared.refute_dispatch.prompt
    : `${prepared.refute_dispatch.prompt.slice(0, markerStart)}${REFUTE_PASS_MARKER}${JSON.stringify(signed)}${REFUTE_PASS_MARKER_CLOSE}`;
  const sealed = {
    ...prepared,
    adjudication_id: adjudicationId,
    refute_dispatch: { ...prepared.refute_dispatch, prompt },
  };
  preparedById.set(adjudicationId, {
    prepared: sealed,
    sessionId,
    budgetExhausted: false,
    completed: false,
    refuteResult: null,
  });
  return sealed;
}

/** @description Verify that one Task marker was minted for this exact session and primary role. */
export function verifyRefutePassIdentity(prompt, { sessionId, role } = {}) {
  const envelope = markerEnvelope(prompt);
  if (!envelope) return { ok: false, reason: "signed refute-pass marker missing" };
  const { payload, markerStart } = envelope;
  const expectedKeys = [
    "adjudication_id", "brief_hash", "epoch", "feature_id", "primary_report_hash",
    "refute_id", "role", "session_id", "signature", "version",
  ].sort();
  if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(expectedKeys)) return { ok: false, reason: "signed refute-pass marker is not canonical" };
  if (
    payload.version !== 1 || typeof payload.adjudication_id !== "string" ||
    typeof payload.refute_id !== "string" || !/^[a-f0-9]{64}$/.test(payload.refute_id) ||
    payload.role !== role || payload.session_id !== sessionId ||
    typeof payload.feature_id !== "string" || !Number.isInteger(payload.epoch) || payload.epoch < 1 ||
    typeof payload.primary_report_hash !== "string" || !/^[a-f0-9]{64}$/.test(payload.primary_report_hash) ||
    payload.brief_hash !== hashBrief(prompt.slice(0, markerStart)) ||
    typeof payload.signature !== "string" || !/^[a-f0-9]{64}$/.test(payload.signature)
  ) return { ok: false, reason: "signed refute-pass identity mismatch" };
  const expected = Buffer.from(signature(payload), "hex");
  const actual = Buffer.from(payload.signature, "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return { ok: false, reason: "signed refute-pass signature mismatch" };
  const stored = preparedById.get(payload.adjudication_id);
  if (!stored || stored.prepared.refute_pass_id !== payload.refute_id || stored.prepared.role !== role) {
    return { ok: false, reason: "signed refute-pass state missing" };
  }
  return {
    ok: true,
    refutePassId: payload.refute_id,
    adjudicationId: payload.adjudication_id,
    featureId: payload.feature_id,
    epoch: payload.epoch,
    primaryReportHash: payload.primary_report_hash,
  };
}

/** @description Re-sign a trusted plan-gate prompt mutation so the whole brief remains covered. */
export function resealRefutePrompt(prompt, { sessionId, role } = {}) {
  const envelope = markerEnvelope(prompt);
  if (!envelope) return prompt;
  const stored = preparedById.get(envelope.payload.adjudication_id);
  if (!stored || stored.sessionId !== sessionId || stored.prepared.role !== role) return prompt;
  const payload = { ...envelope.payload, brief_hash: hashBrief(prompt.slice(0, envelope.markerStart)) };
  payload.signature = signature(payload);
  return `${prompt.slice(0, envelope.markerStart)}${REFUTE_PASS_MARKER}${JSON.stringify(payload)}${REFUTE_PASS_MARKER_CLOSE}`;
}

/** @description Bind one optional-eye Task call to the primary receipt current at dispatch time. */
export function beginSecondEyeDispatch({ sessionId, callId, role, featureId, epoch, primaryReportHash }) {
  if (!sessionId || !callId || !role || !featureId || !Number.isInteger(epoch) || !primaryReportHash) return false;
  secondaryByCall.set(`${sessionId}\0${callId}`, {
    sessionId, callId, role, featureId, epoch, primaryReportHash, completed: false, result: null,
  });
  return true;
}

export function recordSecondEyeDispatchResult({ sessionId, callId, result }) {
  const entry = secondaryByCall.get(`${sessionId}\0${callId}`);
  if (!entry || entry.completed) return false;
  entry.completed = true;
  entry.result = result;
  return true;
}

/** @description Consume the newest completed second eye bound to this exact primary receipt. */
export function consumeSecondEyeDispatch({ sessionId, role, featureId, epoch, primaryReportHash }) {
  const matches = [...secondaryByCall.entries()].filter(([, entry]) =>
    entry.completed && entry.sessionId === sessionId && entry.role === role &&
    entry.featureId === featureId && entry.epoch === epoch && entry.primaryReportHash === primaryReportHash
  );
  const latest = matches.at(-1);
  if (!latest) return { ok: false, reason: "captured second-eye result missing" };
  secondaryByCall.delete(latest[0]);
  return { ok: true, result: latest[1].result };
}

export function markRefuteBudgetExhausted(adjudicationId) {
  const stored = preparedById.get(adjudicationId);
  if (stored) {
    stored.budgetExhausted = true;
    stored.completed = true;
    stored.refuteResult = "refute-pass budget exhausted";
  }
}

/** @description Capture the real Task boundary result once; caller text is never authoritative. */
export function recordRefuteDispatchResult(adjudicationId, result) {
  const stored = preparedById.get(adjudicationId);
  if (!stored || stored.completed) return false;
  stored.completed = true;
  stored.refuteResult = result;
  return true;
}

/** @description Consume host-held prepared state once; caller JSON can never replace it. */
export function consumePreparedAdjudication(adjudicationId, { sessionId } = {}) {
  const stored = preparedById.get(adjudicationId);
  if (!stored) return { ok: false, reason: "prepared adjudication missing or already consumed" };
  if (stored.sessionId !== sessionId) return { ok: false, reason: "prepared adjudication session mismatch" };
  if (!stored.completed) return { ok: false, reason: "refute dispatch outcome missing" };
  preparedById.delete(adjudicationId);
  return {
    ok: true,
    prepared: stored.prepared,
    refuteResult: stored.refuteResult,
    refutePassAttemptCount: stored.budgetExhausted ? REFUTE_PASS_BUDGET + 1 : 1,
  };
}

function hashBrief(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
