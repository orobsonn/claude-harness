/** @description Atomic review reservations, terminal accounting, dual authority, and review-cap epochs. */

import crypto from "node:crypto";
import { bareRole, isExecutorRole, isSniperRole, isTestAuthorRole } from "./roles.mjs";
import { reviewAgentIdentity } from "../../agents/review-catalog.mjs";
import { parseReviewReportText, validateReviewReport } from "../../../shared/lib/review-report-schema.mjs";
import {
  dualStatusPhaseFromRole,
  normalizeDualStatusMap,
  stableDualStatusMap,
} from "../../../shared/lib/gate-state-shape.mjs";
import { sealedMarkerRecord } from "./marker-seal.mjs";
import { deriveCanonicalReviewRestart } from "./review-restart.mjs";
import { isSafeFeatureId } from "../../../shared/lib/feature-id.mjs";

import { AGENT_RETRY_K } from "../../../shared/lib/agent-retry.mjs";

export const LOOP_THRESHOLDS = Object.freeze({
  plan_review: Object.freeze({ warn: 2, deny: 5 }),
  adversary: Object.freeze({ warn: 2, deny: 4 }),
  /** Consecutive primary (family-1) failure streak — same K as all-agent retry. */
  primary_failure_streak: Object.freeze({ deny: AGENT_RETRY_K }),
});

const MAX_EPOCH_RECEIPTS = 4096;
const MAX_FAILURE_COUNT = 1000;
const FAILURE_CLASSES = new Set([
  "empty",
  "denied",
  "malformed",
  "timeout",
  "unauthenticated",
  "provider_error",
  "upstream_5xx",
  "rate_limited",
  "credit",
  "gate_blocked",
]);

/**
 * Harness-internal deny errors are thrown with a bracketed source tag (e.g.
 * `[plan-gate] …`, `[loop-guard] …`). They are NOT provider failures — labeling
 * them provider_error pollutes the provider forensics and the primary failure
 * streak with a self-inflicted cause. Match the tag anywhere (an Error's text is
 * `Error: [plan-gate] …`, so the tag is not at string start).
 */
const HARNESS_DENY_TAG =
  /\[(?:plan-gate|plan-write-gate|planner-recovery|loop-guard|entry-gate|marker-authority|command-resolver|obs-hand|money-preflight|money|dual[\w-]*|bash-decide|gate)\]/i;

const DIAGNOSTIC_MESSAGE_MAX = 280;

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

/**
 * @description Write dual_status for one phase axis (map form). Legacy scalar is
 * normalized to { plan_review } first so adversary writes never clobber plan dual.
 * Seal payload is the full stable dual_status map.
 * @param {Record<string, unknown>} state
 * @param {string} status
 * @param {"plan_review" | "adversary"} phase
 */
function dualState(state, status, phase) {
  const sessionId = typeof state.session_id === "string" ? state.session_id : "";
  const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
  if (!sessionId || !featureId) return { ok: false, reason: "dual transition requires classified identity" };
  if (phase !== "plan_review" && phase !== "adversary") {
    return { ok: false, reason: `invalid dual_status phase: ${String(phase)}` };
  }
  const nextMap = stableDualStatusMap({
    ...normalizeDualStatusMap(state.dual_status),
    [phase]: status,
  });
  const seal = sealedMarkerRecord({ sessionId, featureId, operation: "dual", payload: nextMap });
  const prior = Array.isArray(state.marker_seals) ? state.marker_seals : [];
  return {
    ok: true,
    state: {
      ...state,
      dual_status: nextMap,
      marker_seals: [...prior.filter((candidate) => candidate?.operation !== "dual"), seal],
    },
  };
}

/** @description dual_status phase for a review reservation; unknown role → null (fail-closed). */
function dualPhaseForReservation(reservation) {
  return dualStatusPhaseFromRole(reservation?.logical_role) ?? null;
}

/** @description Normalize plan-review verdict; only APPROVE stays APPROVE (else REVISE). */
function normPlanVerdict(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "APPROVE" ? "APPROVE" : "REVISE";
}

/**
 * @description Persist + seal plan_verdict from useful plan-reviewer only.
 * either-REVISE-wins across families on the same scope (dual pair).
 * No unconditional sticky REVISE: a later dual pair of APPROVE+APPROVE on the same
 * scope must be able to unlock delivery after the plan was fixed (money-preflight
 * still blocks while either peer on this scope is REVISE).
 */
function withPlanVerdict(next, state, classified, reservation, scope) {
  if (reservation.logical_role !== "plan-reviewer" || classified.kind !== "useful") {
    return next;
  }
  const v = normPlanVerdict(object(classified.report).verdict);
  let verdict = v;
  const otherSameScope =
    reservation.family === 1
      ? state.secondary_review_last_scope_hash === scope
      : state.primary_review_last_scope_hash === scope;
  if (otherSameScope) {
    const otherReport =
      reservation.family === 1
        ? state.secondary_review_last_report
        : state.primary_review_last_report;
    const otherV = normPlanVerdict(object(otherReport).verdict);
    // either-REVISE-wins for the dual pair currently on this scope
    verdict = v === "REVISE" || otherV === "REVISE" ? "REVISE" : "APPROVE";
  }
  const sessionId = typeof next.session_id === "string" ? next.session_id : typeof state.session_id === "string" ? state.session_id : "";
  const featureId = typeof next.feature_id === "string" ? next.feature_id : typeof state.feature_id === "string" ? state.feature_id : "";
  if (!sessionId || !featureId) {
    return { ...next, plan_verdict: verdict };
  }
  const seal = sealedMarkerRecord({
    sessionId,
    featureId,
    operation: "plan_verdict",
    payload: verdict,
  });
  const prior = Array.isArray(next.marker_seals) ? next.marker_seals : Array.isArray(state.marker_seals) ? state.marker_seals : [];
  return {
    ...next,
    plan_verdict: verdict,
    marker_seals: [...prior.filter((c) => c?.operation !== "plan_verdict"), seal],
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

/** @description Cap for consecutive primary review failures (malformed/empty/denied/…); default 3. */
export function primaryFailureStreakCap(overrides = {}) {
  const deny = overrides.primaryFailureStreakDeny ?? LOOP_THRESHOLDS.primary_failure_streak.deny;
  return Number.isInteger(deny) && deny > 0 ? deny : LOOP_THRESHOLDS.primary_failure_streak.deny;
}

const REVIEW_CAP_STATUSES = new Set(["review_cap_reached", "primary_failure_cap_reached"]);

/** @description Archive the capped epoch only when both canonical generation and bound snapshot advanced. */
export function reopenReviewEpoch(stateValue, options = {}) {
  const state = object(stateValue);
  if (!REVIEW_CAP_STATUSES.has(state.review_status)) return { ok: false, reason: "review cap is not active", state };
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
      // The round stamp must fall with the counter it indexes. Left stale, a stamp of N would
      // refuse the round credit for rounds 1..N of the reopened epoch and the restarted run would
      // deadlock EARLIER than an unfixed one. The session dispatch ceiling is not reset here.
      planner_attempts_round: 0,
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
      primary_review_last_report: null,
      secondary_review_last_report: null,
      dual_status: undefined,
      plan_verdict: undefined,
      marker_seals: (Array.isArray(state.marker_seals) ? state.marker_seals : []).filter(
        (candidate) => candidate?.operation !== "dual" && candidate?.operation !== "plan_verdict",
      ),
    },
  };
}

function primaryFailureStreakOf(state) {
  const raw = state.primary_review_failure_streak;
  if (Number.isInteger(raw) && raw >= 0) return raw;
  // Corrupt / non-integer streak must not reopen budget (fail closed as exhausted).
  if (raw == null) return 0;
  return Number.MAX_SAFE_INTEGER;
}

/** @description Reserve one exact review call without incrementing useful accounting. */
export function reserveReviewAttempt(stateValue, input = {}) {
  let state = object(stateValue);
  if (REVIEW_CAP_STATUSES.has(state.review_status)) {
    const reopened = reopenReviewEpoch(state, { projectRoot: input.projectRoot });
    if (!reopened.ok) {
      const label = state.review_status;
      return { ok: false, reason: `${label}: ${reopened.reason}`, state };
    }
    state = reopened.state;
  }
  const identity = reviewAgentIdentity(input.subagentType);
  const sessionId = typeof input.sessionId === "string" ? input.sessionId : "";
  const suppliedFeatureId = typeof input.featureId === "string" ? input.featureId : "";
  const featureId = typeof state.feature_id === "string" ? state.feature_id : "";
  const callId = typeof input.callId === "string" ? input.callId : "";
  if (
    !identity ||
    !sessionId ||
    !callId ||
    state.session_id !== sessionId ||
    !isSafeFeatureId(featureId) ||
    (suppliedFeatureId && suppliedFeatureId !== featureId)
  ) {
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
  // The plan-review scope must move with the artifact under review. Without this, every revision
  // round shares one scope, so `withPlanVerdict`'s either-REVISE-wins pairs a fresh report with a
  // peer's REVISE from an EARLIER round — a family-1 APPROVE on a re-planned artifact is overridden
  // by a stale peer verdict and the run can never reach APPROVE (observed live: round-2 REVISE from
  // family-2 pinned the verdict while family-2 malformed in the next round, so nothing cleared it).
  if (identity.logicalRole === "plan-reviewer") {
    const binding = object(state.planner_plan_binding);
    reservation.plan_binding_hash = typeof binding.snapshot_hash === "string" ? binding.snapshot_hash : "";
  }
  reservation.identity_hash = identityKey(reservation);
  const outcomes = currentReceipts(state);
  const inflight = currentInflight(state);
  if (outcomes.length + inflight.length >= MAX_EPOCH_RECEIPTS) {
    // Not "verified restart required": a reopen only runs under a cap status, and an adversary loop
    // no longer sets one — so this bound has no in-session recovery. Say that instead of sending the
    // operator after a restart that cannot work.
    return {
      ok: false,
      reason: `review epoch receipt bound reached (${MAX_EPOCH_RECEIPTS}) — no in-session recovery exists for this bound; report it to the operator and start a new session`,
      state,
    };
  }
  if (outcomes.some((item) => item?.identity_hash === reservation.identity_hash)) {
    return { ok: false, reason: "review call already has terminal outcome", state };
  }
  if (inflight.some((item) => item?.identity_hash === reservation.identity_hash)) {
    return { ok: true, accepted: false, reservation, state };
  }
  if (identity.family === 1) {
    const failureCap = primaryFailureStreakCap(input);
    // The streak means "THIS eye keeps returning garbage" — it is evidence about one role, never a
    // verdict on the next phase's eye. Left global, a broken spec-adversary barred every later
    // family-1 eye (plan-reviewer, per-task adversary, final review) for the rest of the session,
    // and since reservations are refused before dispatch no useful outcome could ever clear it.
    // Absent owner (legacy state) keeps the old global behaviour — conservative, not fail-open.
    const streakRole = typeof state.primary_review_failure_streak_role === "string" ? state.primary_review_failure_streak_role : "";
    const failureStreak = streakRole && streakRole !== identity.logicalRole ? 0 : primaryFailureStreakOf(state);
    const inflightFamily1 = inflight.filter((item) => item?.family === 1 && item?.epoch === epoch).length;
    if (failureStreak + inflightFamily1 >= failureCap) {
      const specPhaseEye =
        identity.logicalRole === "adversary" &&
        !(typeof input.taskId === "string" && input.taskId.trim()) &&
        state.adversary_fired !== true;
      return {
        ok: false,
        reason: specPhaseEye
          ? `[loop-guard] the spec-adversary eye returned an unusable report ${Math.min(failureStreak, failureCap)}/${failureCap} times — do NOT re-dispatch it, the schema or the prompt is the problem, not the spec. Nothing is frozen: report this to the operator in product language (the spec could not be attacked, so it goes to the plan unattacked or the run stops — their call) and STOP looping.`
          : `[loop-guard] primary failure-cap: ${identity.canonicalName} streak=${Math.min(failureStreak, failureCap)}/${failureCap} inflight_family1=${inflightFamily1}. Halt. Fix review prompt/schema, then verified ceremony restart (new generation+plan binding) before re-dispatch.`,
        state,
      };
    }
    const key = loopCounterKey(identity.canonicalName);
    const { deny } = thresholdsFor(key, input);
    const count = Number.isInteger(state[key]) ? state[key] : 0;
    const reserved = inflight.filter((item) => item?.family === 1 && item?.logical_role === identity.logicalRole && item?.epoch === epoch).length;
    // The ADVERSARY loop has no deterministic refusal. A hard cap here fired twice on legitimate
    // work — once on a spec-refinement loop before the planner had run, and it was one run-wide
    // counter away from doing it mid-implementation — and each time the run had no way out. The
    // Claude Code variant has no such cap and does not stall this way. Convergence is now driven by
    // the adversary nudge, which tells the orchestrator to stop and escalate to the operator when
    // the rounds stop producing progress. The PLAN-REVIEW loop keeps its deterministic cap: a REVISE
    // verdict genuinely forbids every writing hand, so that budget is load-bearing.
    if (key === "plan_review_count" && count + reserved >= deny) {
      return { ok: false, reason: `${key} has no remaining useful-review reservation slot`, state };
    }
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
  const diagnostic = input.diagnostic && typeof input.diagnostic === "object" && !Array.isArray(input.diagnostic)
    ? input.diagnostic
    : input.error != null
      ? sanitizeProviderDiagnostic(input.error, { model: input.model, callId: input.callId })
      : null;
  const classified = input.failureClass
    ? { kind: "failure", failureClass: FAILURE_CLASSES.has(input.failureClass) ? input.failureClass : "provider_error" }
    : reportClassification(input.response, reservation.logical_role, reservation.family);
  const outcome = {
    ...reservation,
    outcome: classified.kind,
    failure_class: classified.kind === "failure" ? classified.failureClass : undefined,
    report_hash: classified.kind === "useful" ? classified.reportHash : undefined,
    material_unresolved: classified.kind === "useful" ? classified.materialUnresolved : undefined,
    ...(classified.kind === "failure" && diagnostic ? { diagnostic } : {}),
  };
  let next = {
    ...state,
    review_inflight: currentInflight(state).filter((item) => item?.identity_hash !== reservation.identity_hash),
    review_outcomes: [...outcomes, outcome],
  };
  const prefix = reservation.family === 1 ? "primary" : "secondary";
  if (classified.kind === "failure") {
    // A harness-internal deny means this eye never ran. It is evidence about the DISPATCH, not
    // about the eye or its model family — so it is recorded for forensics but must not consume the
    // failure streak, trip the primary cap, or degrade the cross-family review to primary_only.
    // (A real run lost its second-family plan review to two self-inflicted plan-gate denials.)
    const gateBlocked = classified.failureClass === "gate_blocked";
    const counts = { ...object(state.review_failure_counts) };
    counts[classified.failureClass] = bounded(counts[classified.failureClass], 1);
    next[`${prefix}_review_failure_count`] = bounded(state[`${prefix}_review_failure_count`], 1);
    if (gateBlocked) {
      if (diagnostic) next.last_gate_diagnostic = diagnostic;
      next.review_failure_counts = counts;
      return { state: next, accepted: true, classified };
    }
    // A streak belongs to the role that produced it: a different family-1 eye failing starts its own.
    const priorStreakRole = typeof state.primary_review_failure_streak_role === "string" ? state.primary_review_failure_streak_role : "";
    const continuesStreak = reservation.family !== 1 || !priorStreakRole || priorStreakRole === reservation.logical_role;
    next[`${prefix}_review_failure_streak`] = continuesStreak ? bounded(state[`${prefix}_review_failure_streak`], 1) : 1;
    if (reservation.family === 1) next.primary_review_failure_streak_role = reservation.logical_role;
    if (diagnostic) next.last_provider_diagnostic = diagnostic;
    if (reservation.family === 1) {
      const failureCap = primaryFailureStreakCap(input);
      // A broken SPEC-phase eye stops being dispatched (the streak refusal in reserveReviewAttempt
      // does that, and retrying an unparseable schema is pointless) — but it must not write the
      // freezing status. Same category error as the round cap: a spec-phase failure would deny every
      // writing hand and the delivery for the rest of the run, in a phase where nothing has been
      // written yet. The live incident's round 1 was malformed; two more and the run would have
      // bricked before the planner ever ran. A per-task adversary or a plan-reviewer keeps the
      // freezing status — there the code already exists and a broken eye means it cannot be judged.
      const specPhaseEye =
        reservation.logical_role === "adversary" && !reservation.task_id && state.adversary_fired !== true;
      if (next.primary_review_failure_streak >= failureCap && next.review_status !== "review_cap_reached" && !specPhaseEye) {
        next.review_status = "primary_failure_cap_reached";
        next.cap_generation = state.ceremony_generation;
        next.cap_snapshot_hash = snapshotHash(state);
        next.review_cap_receipt = {
          epoch: epochOf(state),
          identity_hash: reservation.identity_hash,
          failure_class: classified.failureClass,
          cap_generation: state.ceremony_generation,
          cap_snapshot_hash: snapshotHash(state),
          kind: "primary_failure_cap",
          ...(diagnostic ? { diagnostic } : {}),
        };
      }
    }
    if (reservation.family === 2 && state.primary_review_last_scope_hash === scopeHash(reservation)) {
      const failPhase = dualPhaseForReservation(reservation);
      if (!failPhase) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
      const signed = dualState(next, "primary_only", failPhase);
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
  if (reservation.family === 1) next.primary_review_failure_streak_role = null;
  const scope = scopeHash(reservation);
  const dualPhase = dualPhaseForReservation(reservation);
  if (reservation.family === 2) {
    next.secondary_review_last_report_hash = classified.reportHash;
    next.secondary_review_last_scope_hash = scope;
    next.secondary_review_last_report = classified.report;
    next = withPlanVerdict(next, state, classified, reservation, scope);
    // Secondary useful without matching primary scope → pending (never false both / merge).
    const status = state.primary_review_last_scope_hash === scope ? "both" : "pending";
    if (!dualPhase) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
    const signed = dualState(next, status, dualPhase);
    if (!signed.ok) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
    // Clear the peer's failure class with its status: a live gate-state carried
    // dual_secondary_failure_class "malformed" next to dual_secondary_status "useful".
    next = { ...signed.state, dual_secondary_status: "useful", dual_secondary_failure_class: null };
    return {
      state: next,
      accepted: true,
      classified,
      dualPhase,
      scopeHash: scope,
      dualBecameBoth: status === "both",
    };
  }

  const key = loopCounterKey(reservation.canonical_identity);
  const count = bounded(state[key], 1);
  next[key] = count;
  // Snapshot the spec pass's material issues into their OWN field. Reading them off
  // `primary_review_last_report` at planner time only worked for the FIRST plan: the first
  // plan-reviewer outcome overwrites that field, so a risk the planner dropped could never be
  // re-stated on a re-plan — it vanished permanently. Accepting a risk must not mean losing it.
  if (reservation.logical_role === "adversary" && state.adversary_fired !== true) {
    const issues = Array.isArray(object(classified.report).issues) ? object(classified.report).issues : [];
    const open = issues
      .filter((value) => {
        const issue = object(value);
        return issue.severity === "medium" || issue.severity === "high";
      })
      .slice(0, 20)
      .map((value) => {
        const issue = object(value);
        return {
          severity: issue.severity,
          scope: typeof issue.scope === "string" ? issue.scope : "",
          description: typeof issue.description === "string" ? issue.description.slice(0, 600) : "",
          fix_hint: typeof issue.fix_hint === "string" ? issue.fix_hint.slice(0, 600) : "",
        };
      });
    next.spec_adversary_open_risks = open;
  }
  next.primary_review_last_report_hash = classified.reportHash;
  next.primary_review_last_scope_hash = scope;
  next.primary_review_last_report = classified.report;
  next.primary_review_last_material_unresolved = classified.materialUnresolved;
  next = withPlanVerdict(next, state, classified, reservation, scope);
  const status = state.secondary_review_last_scope_hash === scope ? "both" : "primary_only";
  if (!dualPhase) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
  const signed = dualState(next, status, dualPhase);
  if (!signed.ok) return { state, accepted: false, classified: { kind: "failure", failureClass: "malformed" } };
  next = signed.state;
  // A REVISE is an instruction to re-plan — progress, not a planner failure. Credit a fresh
  // planner failure-retry budget for the new round, so the advertised review budget is actually
  // reachable instead of being consumed by the planner's K=3. Stamped with the round number: the
  // credit is idempotent under a replayed outcome and cannot fire twice for one round. The
  // session-lifetime ceiling in planner-state is what still bounds the total spend, and
  // `agent_dispatch_failures` is deliberately left alone (clearing it would mask a real
  // precondition failure and destroy forensics for an agent with no fallback ladder).
  const { deny } = thresholdsFor(key, input);
  // Not at the cap: the round below trips `review_cap_reached`, after which `reserveReviewAttempt`
  // refuses every reviewer slot until a verified restart. Crediting there would advertise a full
  // planner budget with no reviewer left to read the result — two Opus-tier re-plans nobody can
  // approve, on an engine that auto-merges.
  if (key === "plan_review_count" && next.plan_verdict === "REVISE" && count < deny) {
    const stampedRound = Number.isInteger(next.planner_attempts_round) ? next.planner_attempts_round : 0;
    if (count > stampedRound) {
      next.planner_attempts_round = count;
      next.planner_primary_attempts = 0;
    }
  }
  if (count >= deny && classified.materialUnresolved) {
    // Only the plan-review verdict loop reaches a hard cap. An adversary loop records its rounds
    // and lets the nudge escalate to the operator; it never writes a status that freezes the run.
    if (key === "adversary_loop_count") {
      return {
        state: next,
        accepted: true,
        classified,
        dualPhase,
        scopeHash: scope,
        dualBecameBoth: status === "both",
      };
    }
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
  return {
    state: next,
    accepted: true,
    classified,
    dualPhase,
    scopeHash: scope,
    dualBecameBoth: status === "both",
  };
}

function scopeHash(reservation) {
  const scope = { logical_role: reservation.logical_role, feature_id: reservation.feature_id, task_id: reservation.task_id, phase: reservation.phase, epoch: reservation.epoch };
  // Present only on plan-reviewer reservations, and omitted when empty, so adversary/other scopes
  // keep their existing hash semantics.
  if (typeof reservation.plan_binding_hash === "string" && reservation.plan_binding_hash) {
    scope.plan_binding_hash = reservation.plan_binding_hash;
  }
  return digest(scope);
}

export function decideLoopGuard(input = {}) {
  const key = loopCounterKey(input.subagentType);
  if (!key) return { ok: true, decision: "allow", reason: "not-loop-guarded" };
  const count = Number.isFinite(input.count) ? Math.max(0, Math.floor(input.count)) : 0;
  const { warn, deny } = thresholdsFor(key, input);
  // The adversary loop is never denied deterministically — see reserveReviewAttempt. Past the
  // threshold it warns; stopping is the orchestrator's call, driven by the adversary nudge, which
  // tells it to escalate to the operator instead of grinding out rounds that change nothing.
  if (count >= deny && key === "plan_review_count") {
    return { ok: false, decision: "deny", reason: `[loop-guard] Blocked: deny ${key}=${count} reached useful-review cap ${deny} for ${bareRole(input.subagentType)}.`, count, counterKey: key };
  }
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
  const status = object(input.gateState).review_status;
  if (status === "review_cap_reached") {
    return { ok: false, decision: "deny", reason: "review_cap_reached: verified review restart required" };
  }
  if (status === "primary_failure_cap_reached") {
    return {
      ok: false,
      decision: "deny",
      reason: "primary_failure_cap_reached: writing hands blocked until canonical ceremony restart",
    };
  }
  return { ok: true, decision: "allow", reason: "review-cap-not-reached" };
}

/**
 * @description Sanitize a provider/Task error into a bounded diagnostic (no secrets).
 * @param {unknown} error
 * @param {{ model?: unknown, callId?: unknown }} [meta]
 * @returns {Record<string, unknown> | null}
 */
export function sanitizeProviderDiagnostic(error, meta = {}) {
  try {
    const obj = object(error);
    const data = object(obj.data);
    const statusRaw = obj.statusCode ?? obj.status ?? data.statusCode ?? data.status;
    const statusNum = Number(statusRaw);
    const source = text(error).replace(
      /(api[_-]?key|authorization|bearer|token|password)\s*[:=]\s*\S+/gi,
      "$1=[redacted]",
    );
    const message = source.slice(0, DIAGNOSTIC_MESSAGE_MAX);
    const model = typeof meta.model === "string" ? meta.model.slice(0, 80) : undefined;
    const callId = typeof meta.callId === "string" ? meta.callId.slice(0, 128) : undefined;
    /** @type {Record<string, unknown>} */
    const out = {
      at: new Date().toISOString(),
      message,
    };
    if (Number.isFinite(statusNum)) out.status = statusNum;
    if (model) out.model = model;
    if (callId) out.call_id = callId;
    const name = typeof obj.name === "string" ? obj.name.slice(0, 80) : undefined;
    if (name) out.name = name;
    return out;
  } catch {
    return null;
  }
}

export function classifyReviewBoundaryError(error) {
  const source = text(error);
  // Harness-internal deny (thrown by our own gates) — must win before any status /
  // pattern branch, else e.g. "[entry-gate] Blocked: request denied" reads as "denied".
  if (HARNESS_DENY_TAG.test(source)) return "gate_blocked";
  const statusRaw = object(error).statusCode ?? object(error).status ?? object(object(error).data).statusCode ?? object(object(error).data).status;
  const status = Number(statusRaw ?? source.match(/\b([45]\d\d)\b/)?.[1]);
  if (status === 401) return "unauthenticated";
  if (status === 402 || /insufficient.?credit|payment required|quota exceeded/i.test(source)) return "credit";
  if (status === 429 || /rate.?limit|too many requests/i.test(source)) return "rate_limited";
  if (status === 403) return /auth|login|token|api key/i.test(source) ? "unauthenticated" : "denied";
  if (status === 408 || status === 504 || /timeout|timed out|deadline exceeded|aborted/i.test(source)) return "timeout";
  if (Number.isFinite(status) && status >= 500) return "upstream_5xx";
  if (/unauthori[sz]ed|not authenticated|login required|invalid api key|providerautherror/i.test(source)) return "unauthenticated";
  if (/permission denied|access denied|request denied/i.test(source)) return "denied";
  return "provider_error";
}

export function throwIfLoopDenied(decision) {
  if (decision?.decision === "deny") throw new Error(decision.reason || "[loop-guard] denied");
}
