/** @description Atomic single-evaluator review reservations, terminal accounting, and review-cap epochs. */

import crypto from "node:crypto";
import { bareRole } from "./roles.mjs";
import { reviewAgentIdentity } from "../../agents/review-catalog.mjs";
import { parseReviewReportText, validateReviewReport } from "../../../shared/lib/review-report-schema.mjs";
import { deriveCanonicalReviewRestart } from "./review-restart.mjs";
import { isSafeFeatureId } from "../../../shared/lib/feature-id.mjs";

import { AGENT_RETRY_K } from "../../../shared/lib/agent-retry.mjs";

export const LOOP_THRESHOLDS = Object.freeze({
  plan_review: Object.freeze({ warn: 2, deny: 10 }),
  adversary: Object.freeze({ warn: 2, deny: 4 }),
  /** Consecutive unusable results from one evaluator — same K as all-agent retry. */
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
  /\[(?:plan-gate|plan-write-gate|planner-recovery|loop-guard|entry-gate|marker-authority|obs-hand|money-preflight|money|dual[\w-]*|bash-decide|gate)\]/i;

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
    call_id: receipt.call_id,
    epoch: receipt.epoch,
  });
}

function canonicalReviewIdentity(value) {
  return reviewAgentIdentity(value)?.canonicalName ?? (typeof value === "string" ? value : "");
}

function sameReviewCall(left, right) {
  return Boolean(
    left &&
    right &&
    canonicalReviewIdentity(left.canonical_identity) === canonicalReviewIdentity(right.canonical_identity) &&
    left.session_id === right.session_id &&
    left.feature_id === right.feature_id &&
    left.logical_role === right.logical_role &&
    left.call_id === right.call_id &&
    left.epoch === right.epoch
  );
}

function countsForSingleEvaluator(reservation) {
  if (!reservation) return false;
  const { family } = reservation;
  if (family != null) return family === 1;
  const identity = reviewAgentIdentity(reservation.canonical_identity);
  return identity ? identity.countsLoop === true : true;
}

function currentReceipts(state) {
  return Array.isArray(state.review_outcomes) ? state.review_outcomes : [];
}

function currentInflight(state) {
  return Array.isArray(state.review_inflight) ? state.review_inflight : [];
}

/** @description Normalize plan-review verdict; only APPROVE stays APPROVE (else REVISE). */
function normPlanVerdict(v) {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "APPROVE" ? "APPROVE" : "REVISE";
}

/** @description Persist the current useful plan-review verdict from the single evaluator. */
function withPlanVerdict(next, classified, reservation) {
  if (reservation.logical_role !== "plan-reviewer" || classified.kind !== "useful") {
    return next;
  }
  return { ...next, plan_verdict: normPlanVerdict(object(classified.report).verdict) };
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
      review_status: "active",
      review_cap_receipt: null,
      cap_generation: null,
      cap_snapshot_hash: null,
      primary_review_last_scope_hash: null,
      primary_review_last_report_hash: null,
      primary_review_last_report: null,
      dual_status: undefined,
      plan_verdict: undefined,
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
  const stateSessionId = typeof state.session_id === "string" ? state.session_id : "";
  const stateFeatureId = typeof state.feature_id === "string" ? state.feature_id : "";
  // Cold repo (#ac-2.4): a fresh gate-state (e.g. the very first spec-adversary attack, before
  // classify has stamped session_id/feature_id) carries neither yet. Treat "not yet bound" as
  // compatible with whatever this reservation supplies — a REAL mismatch (state already carries
  // a DIFFERENT value) still refuses below. Nothing here weakens that: only the "no prior value
  // recorded" case is exempted.
  const sessionMismatch = stateSessionId !== "" && stateSessionId !== sessionId;
  const featureMismatch = Boolean(stateFeatureId) && Boolean(suppliedFeatureId) && suppliedFeatureId !== stateFeatureId;
  const featureId = stateFeatureId || suppliedFeatureId;
  const callId = typeof input.callId === "string" ? input.callId : "";
  if (
    !identity ||
    !sessionId ||
    !callId ||
    sessionMismatch ||
    !isSafeFeatureId(featureId) ||
    featureMismatch
  ) {
    return { ok: false, reason: "review reservation identity mismatch", state };
  }
  if (!identity.countsLoop) {
    return { ok: true, accepted: false, reservation: null, state };
  }
  const epoch = epochOf(state);
  const reservation = {
    canonical_identity: identity.canonicalName,
    session_id: sessionId,
    feature_id: featureId,
    logical_role: identity.logicalRole,
    call_id: callId,
    epoch,
    task_id: typeof input.taskId === "string" ? input.taskId : "",
    phase: typeof input.phase === "string" ? input.phase : "",
  };
  // The plan-review scope moves with the artifact so receipts remain auditable across revisions.
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
  if (outcomes.some((item) => item?.identity_hash === reservation.identity_hash || sameReviewCall(item, reservation))) {
    return { ok: false, reason: "review call already has terminal outcome", state };
  }
  if (inflight.some((item) => item?.identity_hash === reservation.identity_hash || sameReviewCall(item, reservation))) {
    return { ok: true, accepted: false, reservation, state };
  }
  const failureCap = primaryFailureStreakCap(input);
  const streakRole = typeof state.primary_review_failure_streak_role === "string" ? state.primary_review_failure_streak_role : "";
  const failureStreak = streakRole && streakRole !== identity.logicalRole ? 0 : primaryFailureStreakOf(state);
  const inflightEvaluator = inflight.filter(
    (item) => item?.logical_role === identity.logicalRole && item?.epoch === epoch && countsForSingleEvaluator(item),
  ).length;
  if (failureStreak + inflightEvaluator >= failureCap) {
    const specPhaseEye =
      identity.logicalRole === "adversary" &&
      !(typeof input.taskId === "string" && input.taskId.trim()) &&
      state.adversary_fired !== true;
    return {
      ok: false,
      reason: specPhaseEye
        ? `[loop-guard] the spec-adversary eye returned an unusable report ${Math.min(failureStreak, failureCap)}/${failureCap} times — do NOT re-dispatch it, the schema or the prompt is the problem, not the spec. Nothing is frozen: report this to the operator in product language (the spec could not be attacked, so it goes to the plan unattacked or the run stops — their call) and STOP looping.`
        : `[loop-guard] primary failure-cap: ${identity.canonicalName} streak=${Math.min(failureStreak, failureCap)}/${failureCap} inflight_evaluator=${inflightEvaluator}. Halt. Fix review prompt/schema, then verified ceremony restart (new generation+plan binding) before re-dispatch.`,
      state,
    };
  }
  const key = loopCounterKey(identity.canonicalName);
  const { deny } = thresholdsFor(key, input);
  const count = Number.isInteger(state[key]) ? state[key] : 0;
  const reserved = inflightEvaluator;
  if (key === "plan_review_count" && count + reserved >= deny) {
    return { ok: false, reason: `${key} has no remaining useful-review reservation slot`, state };
  }
  return {
    ok: true,
    accepted: true,
    reservation,
    state: { ...state, review_epoch: epoch, review_inflight: [...inflight, reservation], dual_status: "pending" },
  };
}

function reportClassification(response, logicalRole) {
  const source = text(response).trim();
  if (!source) return { kind: "failure", failureClass: "empty" };
  if (/\b(?:permission denied|access denied|tool denied|request denied)\b/i.test(source)) return { kind: "failure", failureClass: "denied" };
  const report = parseReviewReportText(source);
  if (!report) return { kind: "failure", failureClass: "malformed" };
  const validated = validateReviewReport(logicalRole, report);
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
  const reserved = reviewAgentIdentity(reservation.canonical_identity);
  if (!countsForSingleEvaluator(reservation) || reserved?.countsLoop === false) return null;
  if (supplied && supplied.canonicalName !== canonicalReviewIdentity(reservation.canonical_identity)) return null;
  if (input.featureId && input.featureId !== reservation.feature_id) return null;
  return reservation;
}

/** @description Consume a matching reservation. First terminal outcome for its canonical identity wins. */
export function applyReviewOutcome(stateValue, input = {}) {
  const state = object(stateValue);
  const reservation = matchingReservation(state, input);
  if (!reservation) return { state, accepted: false, classified: { kind: "ignore", reason: "matching reservation missing" } };
  const outcomes = currentReceipts(state);
  if (outcomes.some((item) => item?.identity_hash === reservation.identity_hash || sameReviewCall(item, reservation))) {
    return { state, accepted: false, classified: { kind: "ignore", reason: "terminal outcome already recorded" } };
  }
  const diagnostic = input.diagnostic && typeof input.diagnostic === "object" && !Array.isArray(input.diagnostic)
    ? input.diagnostic
    : input.error != null
      ? sanitizeProviderDiagnostic(input.error, { model: input.model, callId: input.callId })
      : null;
  const classified = input.failureClass
    ? { kind: "failure", failureClass: FAILURE_CLASSES.has(input.failureClass) ? input.failureClass : "provider_error" }
    : reportClassification(input.response, reservation.logical_role);
  const outcome = {
    ...reservation,
    // Persisted outcome compatibility for adversary-nudge.mjs, which remains unchanged in #584.
    // This is a fixed single-evaluator marker, not dispatch authority and not part of reservations.
    family: 1,
    outcome: classified.kind,
    failure_class: classified.kind === "failure" ? classified.failureClass : undefined,
    // The validator says exactly which rule broke; dropping it left "malformed" as the only evidence
    // and cost a full day of guessing schema-vs-model. Bounded, no secrets — it is a schema reason.
    failure_reason: classified.kind === "failure" && typeof classified.reason === "string" ? classified.reason.slice(0, 200) : undefined,
    report_hash: classified.kind === "useful" ? classified.reportHash : undefined,
    material_unresolved: classified.kind === "useful" ? classified.materialUnresolved : undefined,
    ...(classified.kind === "failure" && diagnostic ? { diagnostic } : {}),
  };
  let next = {
    ...state,
    review_inflight: currentInflight(state).filter((item) => item?.identity_hash !== reservation.identity_hash),
    review_outcomes: [...outcomes, outcome],
  };
  if (classified.kind === "failure") {
    // A harness-internal deny means this eye never ran. It is evidence about the DISPATCH, not
    // about the evaluator — so it is recorded for forensics but must not consume the failure streak.
    const gateBlocked = classified.failureClass === "gate_blocked";
    const counts = { ...object(state.review_failure_counts) };
    counts[classified.failureClass] = bounded(counts[classified.failureClass], 1);
    next.primary_review_failure_count = bounded(state.primary_review_failure_count, 1);
    if (gateBlocked) {
      if (diagnostic) next.last_gate_diagnostic = diagnostic;
      next.review_failure_counts = counts;
      return { state: next, accepted: true, classified };
    }
    // A streak belongs to the logical evaluator role that produced it.
    const priorStreakRole = typeof state.primary_review_failure_streak_role === "string" ? state.primary_review_failure_streak_role : "";
    const continuesStreak = !priorStreakRole || priorStreakRole === reservation.logical_role;
    next.primary_review_failure_streak = continuesStreak ? bounded(state.primary_review_failure_streak, 1) : 1;
    next.primary_review_failure_streak_role = reservation.logical_role;
    if (diagnostic) next.last_provider_diagnostic = diagnostic;
    const failureCap = primaryFailureStreakCap(input);
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
    next.review_failure_counts = counts;
    return { state: next, accepted: true, classified };
  }

  next.primary_review_failure_streak = 0;
  next.primary_review_failure_streak_role = null;
  const scope = scopeHash(reservation);

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
  next = withPlanVerdict(next, classified, reservation);
  next.dual_status = currentInflight(next).some(countsForSingleEvaluator) ? "pending" : "done";
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
  if (count >= deny && key === "plan_review_count" && next.plan_verdict === "REVISE") {
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
    scopeHash: scope,
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

/**
 * Headless (cloud fleet) signal — exact mirror of Claude Code entry-gate.mjs `defaultIsHeadless`
 * (entry-gate.mjs:116-118): `Boolean(env.CLAUDE_CODE_REMOTE)`, never any other variable. A
 * fleet-look-alike env (e.g. `HARNESS_NOTIFY_PROJECT` set without `CLAUDE_CODE_REMOTE`) must NOT
 * bypass the interactive round-rail hard-stop below (#ac-2.3).
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
function isHeadlessRemote(env) {
  const source = env && typeof env === "object" ? env : process.env;
  return Boolean(source?.CLAUDE_CODE_REMOTE);
}

/**
 * Churn-warning threshold — past this many dispatches the rail warns (never denies). It is a
 * "look at this" signal, not a budget: the plan-review loop's only budget is
 * `LOOP_THRESHOLDS.plan_review.deny`, surfaced to the orchestrator by `revise_nudge`. The warning
 * text below therefore names no cap and no stop — a second numbered authority delivered on the
 * same metadata channel as the nudge is what aborted a converging review in #529.
 */
export const PLAN_REVIEW_ROUND_WARN_AT = 3;
/**
 * Runaway backstop — past this, the interactive session hard-stops. Derived, never picked: the
 * rail counts DISPATCHES while the budget counts USEFUL rounds, so it must clear the full budget
 * plus one round's worth of failure retries (a malformed/empty/timeout review spends a dispatch
 * without crediting a round). A ceiling at or below `LOOP_THRESHOLDS.plan_review.deny` makes the
 * last rounds unreachable and hands the operator a converging review with budget left — exactly
 * the #529 defect, in runtime instead of prose.
 */
export const PLAN_REVIEW_ROUND_CEILING = LOOP_THRESHOLDS.plan_review.deny + AGENT_RETRY_K;

/**
 * @description Orchestrator-facing plan-review round-rail. Decoupled from the review
 * reservation budget (`LOOP_THRESHOLDS.plan_review`, which governs `review_cap_reached` /
 * reservation-slot exhaustion — a separate OC bookkeeping concern, untouched here). Structurally
 * mirrors Claude Code entry-gate.mjs's Fix C (warn-then-ceiling, ceiling denies on the dispatch
 * past it); the OC numbers are derived from this lane's own budget, not copied from that one:
 * past the churn-warning threshold it warns and permits; past the runaway ceiling it denies —
 * but ONLY in an interactive session. HEADLESS has no operator to
 * escalate to, so it stays warn-only forever there — the fleet engine cap
 * (core/vps/cron-a-exit.mjs, cron-review.mjs) is the real ceiling.
 * @param {{ subagentType?: unknown, count?: number, env?: Record<string, string | undefined> }} [input]
 * @returns {{ ok: boolean, decision: "allow" | "warn" | "deny", reason: string, count: number }}
 */
export function decidePlanReviewRoundRail(input = {}) {
  const key = loopCounterKey(input.subagentType);
  const count = Number.isFinite(input.count) ? Math.max(0, Math.floor(input.count)) : 0;
  if (key !== "plan_review_count") {
    return { ok: true, decision: "allow", reason: "not-plan-review", count };
  }
  const headless = isHeadlessRemote(input.env);
  if (count > PLAN_REVIEW_ROUND_CEILING) {
    if (headless) {
      return {
        ok: true,
        decision: "warn",
        reason:
          `[loop-guard] plan-review round ${count} exceeds the runaway ceiling of ${PLAN_REVIEW_ROUND_CEILING} — ` +
          "headless fleet session (CLAUDE_CODE_REMOTE): the engine cap is authoritative, not denied. " +
          "Confirm this round is genuine new-bug discovery, not churn.",
        count,
      };
    }
    return {
      ok: false,
      decision: "deny",
      reason:
        `[loop-guard] Blocked: plan-review round ${count} exceeds the runaway ceiling of ${PLAN_REVIEW_ROUND_CEILING}. ` +
        "STOP re-dispatching the plan-reviewer: escalate the blocking finding to the operator in product language.",
      count,
    };
  }
  if (count > PLAN_REVIEW_ROUND_WARN_AT) {
    return {
      ok: true,
      decision: "warn",
      reason:
        `[loop-guard] plan-review round ${count}: confirm this round is genuine new-bug discovery, not churn. ` +
        "This is a churn warning, not a budget — the revise_nudge remains the only authority on when this loop ends.",
      count,
    };
  }
  return { ok: true, decision: "allow", reason: "loop-allow", count };
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
