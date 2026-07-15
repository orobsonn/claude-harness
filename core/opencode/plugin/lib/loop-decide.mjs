/** @description Atomic review reservations, terminal accounting, dual authority, and review-cap epochs. */

import crypto from "node:crypto";
import { bareRole, isExecutorRole, isSniperRole, isTestAuthorRole } from "./roles.mjs";
import { reviewAgentIdentity } from "../../agents/review-catalog.mjs";
import { parseReviewReportText, validateReviewReport } from "../../../shared/lib/review-report-schema.mjs";
import { sealedMarkerRecord } from "./marker-seal.mjs";
import { deriveCanonicalReviewRestart } from "./review-restart.mjs";

export const LOOP_THRESHOLDS = Object.freeze({
  plan_review: Object.freeze({ warn: 2, deny: 4 }),
  adversary: Object.freeze({ warn: 2, deny: 4 }),
});

const MAX_EPOCH_RECEIPTS = 4096;
const MAX_FAILURE_COUNT = 1000;
const FAILURE_CLASSES = new Set(["empty", "denied", "malformed", "timeout", "unauthenticated", "provider_error"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function digest(value) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function bounded(value, increment = 0) {
  const current = Number.isInteger(value) && value >= 0 ? value : 0;
  return Math.min(MAX_FAILURE_COUNT, current + increment);
}

function text(value) {
  try {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return typeof value === "string" ? value : JSON.stringify(value ?? "");
  } catch {
    return "";
  }
}

function hasMaterialUnresolved(findings) {
  return findings.some((value) => {
    const finding = object(value);
    const resolved = finding.resolved === true || finding.status === "resolved";
    return !resolved && (finding.severity === "medium" || finding.severity === "high");
  });
}

function epochOf(state) {
  return Number.isInteger(state.review_epoch) && state.review_epoch > 0 ? state.review_epoch : 1;
}

function snapshotHash(state) {
  const value = object(state.planner_plan_binding).snapshot_hash;
  return typeof value === "string" ? value : "";
}

function identityKey(receipt) {
  return digest({
    canonical_identity: receipt.canonical_identity,
    session_id: receipt.session_id,
    feature_id: receipt.feature_id,
    logical_role: receipt.logical_role,
    family: receipt.family,
    call_id: receipt.call_id,
    epoch: receipt.epoch,
  });
}

function currentReceipts(state) {
  return Array.isArray(state.review_outcomes) ? state.review_outcomes : [];
}

function currentInflight(state) {
  return Array.isArray(state.review_inflight) ? state.review_inflight : [];
}

function dualState(state, status) {
  const sessionId = typeof state.session_id === "string" ? state.session_id : "";
  const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
  if (!sessionId || !featureId) return { ok: false, reason: "dual transition requires classified identity" };
  const seal = sealedMarkerRecord({ sessionId, featureId, operation: "dual", payload: status });
  const prior = Array.isArray(state.marker_seals) ? state.marker_seals : [];
  return {
    ok: true,
    state: {
      ...state,
      dual_status: status,
      marker_seals: [...prior.filter((candidate) => candidate?.operation !== "dual"), seal],
    },
  };
}

export function loopCounterKey(subagentType) {
  const identity = reviewAgentIdentity(subagentType);
  if (!identity?.countsLoop) return null;
  if (identity.logicalRole === "plan-reviewer") return "plan_review_count";
  if (identity.logicalRole === "adversary") return "adversary_loop_count";
  return null;
}

export function thresholdsFor(key, overrides = {}) {
  return key === "plan_review_count"
    ? { warn: overrides.planReviewWarn ?? LOOP_THRESHOLDS.plan_review.warn, deny: overrides.planReviewDeny ?? LOOP_THRESHOLDS.plan_review.deny }
    : { warn: overrides.adversaryWarn ?? LOOP_THRESHOLDS.adversary.warn, deny: overrides.adversaryDeny ?? LOOP_THRESHOLDS.adversary.deny };
}

/** @description Archive the capped epoch only when both canonical generation and bound snapshot advanced. */
export function reopenReviewEpoch(stateValue, options = {}) {
  const state = object(stateValue);
  if (state.review_status !== "review_cap_reached") return { ok: false, reason: "review cap is not active", state };
  const capGeneration = state.cap_generation;
  const capSnapshotHash = state.cap_snapshot_hash;
  const canonical = deriveCanonicalReviewRestart(options.projectRoot, state);
  if (!canonical.ok) return { ok: false, reason: canonical.reason, state };
  const archive = {
    epoch: epochOf(state),
    cap_generation: capGeneration,
    cap_snapshot_hash: capSnapshotHash,
    cap_receipt: state.review_cap_receipt,
    outcomes: currentReceipts(state),
    inflight: currentInflight(state),
    plan_review_count: state.plan_review_count ?? 0,
    adversary_loop_count: state.adversary_loop_count ?? 0,
  };
  return {
    ok: true,
    state: {
      ...state,
      review_epoch: epochOf(state) + 1,
      review_epoch_history: [...(Array.isArray(state.review_epoch_history) ? state.review_epoch_history : []), archive],
      review_inflight: [],
      review_outcomes: [],
      plan_review_count: 0,
      adversary_loop_count: 0,
      primary_review_failure_streak: 0,
      secondary_review_failure_streak: 0,
      review_status: "active",
      review_cap_receipt: null,
      cap_generation: null,
      cap_snapshot_hash: null,
      primary_review_last_scope_hash: null,
      secondary_review_last_scope_hash: null,
      primary_review_last_report_hash: null,
      secondary_review_last_report_hash: null,
      dual_status: undefined,
      marker_seals: (Array.isArray(state.marker_seals) ? state.marker_seals : []).filter((candidate) => candidate?.operation !== "dual"),
    },
  };
}

/** @description Reserve one exact review call without incrementing useful accounting. */
export function reserveReviewAttempt(stateValue, input = {}) {
  let state = object(stateValue);
  if (state.review_status === "review_cap_reached") {
    const reopened = reopenReviewEpoch(state, { projectRoot: input.projectRoot });
    if (!reopened.ok) return { ok: false, reason: `review_cap_reached: ${reopened.reason}`, state };
    state = reopened.state;
  }
  const identity = reviewAgentIdentity(input.subagentType);
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const featureId = typeof input.featureId === "string" ? input.featureId : "";
  const callId = typeof input.callId === "string" ? input.callId : "";
  if (!identity || !sessionId || !featureId || !callId || state.session_id !== sessionId || state.feature_id !== featureId) {
    return { ok: false, reason: "review reservation identity mismatch", state };
  }
  const epoch = epochOf(state);
  const reservation = {
    canonical_identity: identity.canonicalName,
    session_id: sessionId,
    feature_id: featureId,
    logical_role: identity.logicalRole,
    family: identity.family,
    call_id: callId,
    epoch,
    task_id: typeof input.taskId === "string" ? input.taskId : "",
    phase: typeof input.phase === "string" ? input.phase : "",
  };
  reservation.identity_hash = identityKey(reservation);
  const outcomes = currentReceipts(state);
  const inflight = currentInflight(state);
  if (outcomes.length + inflight.length >= MAX_EPOCH_RECEIPTS) {
    return { ok: false, reason: "review epoch receipt bound reached; verified restart required", state };
  }
  if (outcomes.some((item) => item?.identity_hash === reservation.identity_hash)) {
    return { ok: false, reason: "review call already has terminal outcome", state };
  }
  if (inflight.some((item) => item?.identity_hash === reservation.identity_hash)) {
    return { ok: true, accepted: false, reservation, state };
  }
  if (identity.family === 1) {
    const key = loopCounterKey(identity.canonicalName);
    const { deny } = thresholdsFor(key, input);
    const count = Number.isInteger(state[key]) ? state[key] : 0;
    const reserved = inflight.filter((item) => item?.family === 1 && item?.logical_role === identity.logicalRole && item?.epoch === epoch).length;
    if (count + reserved >= deny) return { ok: false, reason: `${key} has no remaining useful-review reservation slot`, state };
  }
  return { ok: true, accepted: true, reservation, state: { ...state, review_epoch: epoch, review_inflight: [...inflight, reservation] } };
}

function reportClassification(response, logicalRole, family) {
  const source = text(response).trim();
  if (!source) return { kind: "failure", failureClass: "empty" };
  if (/\b(?:permission denied|access denied|tool denied|request denied)\b/i.test(source)) return { kind: "failure", failureClass: "denied" };
  const report = parseReviewReportText(source);
  if (!report) return { kind: "failure", failureClass: "malformed" };
  const validated = validateReviewReport(logicalRole, report, family);
  if (!validated.ok) return { kind: "failure", failureClass: "malformed", reason: validated.reason };
  return { kind: "useful", report, reportHash: digest(report), materialUnresolved: hasMaterialUnresolved(validated.findings) };
}

function matchingReservation(state, input) {
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const callId = typeof input.callId === "string" ? input.callId : "";
  const matches = currentInflight(state).filter((item) => item?.session_id === sessionId && item?.call_id === callId && item?.epoch === epochOf(state));
  if (matches.length !== 1) return null;
  const reservation = matches[0];
  const supplied = reviewAgentIdentity(input.subagentType);
  if (supplied && supplied.canonicalName !== reservation.canonical_identity) return null;
  if (input.featureId && input.featureId !== reservation.feature_id) return null;
  return reservation;
}

/** @description Consume a matching reservation. First terminal outcome for its canonical identity wins. */
export function applyReviewOutcome(stateValue, input = {}) {
  const state = object(stateValue);
  const reservation = matchingReservation(state, input);
  if (!reservation) return { state, accepted: false, classified: { kind: "ignore", reason: "matching reservation missing" } };
  const outcomes = currentReceipts(state);
  if (outcomes.some((item) => item?.identity_hash === reservation.identity_hash)) {
    return { state, accepted: false, classified: { kind: "ignore", reason: "terminal outcome already recorded" } };
  }
  const classified = input.failureClass
    ? { kind: "failure", failureClass: FAILURE_CLASSES.has(input.failureClass) ? input.failureClass : "provider_error" }
    : reportClassification(input.response, reservation.logical_role, reservation.family);
  const outcome = {
    ...reservation,
    outcome: classified.kind,
    failure_class: classified.kind === "failure" ? classified.failureClass : undefined,
    report_hash: classified.kind === "useful" ? classified.reportHash : undefined,
    material_unresolved: classified.kind === "useful" ? classified.materialUnresolved : undefined,
  };
  let next = {
    ...state,
    review_inflight: currentInflight(state).filter((item) => item?.identity_hash !== reservation.identity_hash),
    review_outcomes: [...outcomes, outcome],
  };
  const prefix = reservation.family === 1 ? "primary" : "secondary";
  if (classified.kind === "failure") {
    const counts = { ...object(state.review_failure_counts) };
    counts[classified.failureClass] = bounded(counts[classified.failureClass], 1);
    next[`${prefix}_review_failure_count`] = bounded(state[`${prefix}_review_failure_count`], 1);
    next[`${prefix}_review_failure_streak`] = bounded(state[`${prefix}_review_failure_streak`], 1);
    if (reservation.family === 2 && state.primary_review_last_scope_hash === scopeHash(reservation)) {
      const signed = dualState(next, "primary_only");
      if (!signed.ok) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
      next = {
        ...signed.state,
        dual_secondary_status: classified.failureClass === "unauthenticated" ? "unavailable" : "failed",
        dual_secondary_failure_class: classified.failureClass,
      };
    }
    next.review_failure_counts = counts;
    return { state: next, accepted: true, classified };
  }

  next[`${prefix}_review_failure_streak`] = 0;
  const scope = scopeHash(reservation);
  if (reservation.family === 2) {
    next.secondary_review_last_report_hash = classified.reportHash;
    next.secondary_review_last_scope_hash = scope;
    const status = state.primary_review_last_scope_hash === scope ? "both" : "pending";
    const signed = dualState(next, status);
    if (!signed.ok) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
    next = { ...signed.state, dual_secondary_status: "useful" };
    return { state: next, accepted: true, classified };
  }

  const key = loopCounterKey(reservation.canonical_identity);
  const count = bounded(state[key], 1);
  next[key] = count;
  next.primary_review_last_report_hash = classified.reportHash;
  next.primary_review_last_scope_hash = scope;
  next.primary_review_last_material_unresolved = classified.materialUnresolved;
  const status = state.secondary_review_last_scope_hash === scope ? "both" : "primary_only";
  const signed = dualState(next, status);
  if (!signed.ok) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
  next = signed.state;
  const { deny } = thresholdsFor(key, input);
  if (count >= deny && classified.materialUnresolved) {
    next.review_status = "review_cap_reached";
    next.cap_generation = state.ceremony_generation;
    next.cap_snapshot_hash = snapshotHash(state);
    next.review_cap_receipt = {
      epoch: epochOf(state),
      identity_hash: reservation.identity_hash,
      report_hash: classified.reportHash,
      cap_generation: state.ceremony_generation,
      cap_snapshot_hash: snapshotHash(state),
    };
  }
  return { state: next, accepted: true, classified };
}

function scopeHash(reservation) {
  return digest({ logical_role: reservation.logical_role, feature_id: reservation.feature_id, task_id: reservation.task_id, phase: reservation.phase, epoch: reservation.epoch });
}

export function decideLoopGuard(input = {}) {
  const key = loopCounterKey(input.subagentType);
  if (!key) return { ok: true, decision: "allow", reason: "not-loop-guarded" };
  const count = Number.isFinite(input.count) ? Math.max(0, Math.floor(input.count)) : 0;
  const { warn, deny } = thresholdsFor(key, input);
  if (count >= deny) return { ok: false, decision: "deny", reason: `[loop-guard] Blocked: deny ${key}=${count} reached useful-review cap ${deny} for ${bareRole(input.subagentType)}.`, count, counterKey: key };
  if (count >= warn) return { ok: true, decision: "warn", reason: `[loop-guard] Warning: ${key}=${count} reached warn threshold ${warn} for ${bareRole(input.subagentType)}.`, count, counterKey: key };
  return { ok: true, decision: "allow", reason: "loop-allow", count, counterKey: key };
}

export function nextLoopCount(gateState, subagentType) {
  const key = loopCounterKey(subagentType);
  if (!key) return null;
  const current = object(gateState)[key];
  return { key, next: (Number.isInteger(current) && current >= 0 ? current : 0) + 1 };
}

export function decideReviewCapBeforeWriting(input = {}) {
  if (!isExecutorRole(input.subagentType) && !isSniperRole(input.subagentType) && !isTestAuthorRole(input.subagentType)) {
    return { ok: true, decision: "allow", reason: "not-writing-hand" };
  }
  if (object(input.gateState).review_status === "review_cap_reached") {
    return { ok: false, decision: "deny", reason: "review_cap_reached: verified review restart required" };
  }
  return { ok: true, decision: "allow", reason: "review-cap-not-reached" };
}

export function classifyReviewBoundaryError(error) {
  const source = text(error);
  const statusRaw = object(error).statusCode ?? object(error).status ?? object(object(error).data).statusCode ?? object(object(error).data).status;
  const status = Number(statusRaw ?? source.match(/\b([45]\d\d)\b/)?.[1]);
  if (status === 401) return "unauthenticated";
  if (status === 403) return /auth|login|token|api key/i.test(source) ? "unauthenticated" : "denied";
  if (status === 408 || status === 504 || /timeout|timed out|deadline exceeded|aborted/i.test(source)) return "timeout";
  if (Number.isFinite(status) && status >= 500) return "provider_error";
  if (/unauthori[sz]ed|not authenticated|login required|invalid api key|providerautherror/i.test(source)) return "unauthenticated";
  if (/permission denied|access denied|request denied/i.test(source)) return "denied";
  return "provider_error";
}

export function throwIfLoopDenied(decision) {
  if (decision?.decision === "deny") throw new Error(decision.reason || "[loop-guard] denied");
}
