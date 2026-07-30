/** @description Pure planner attempt state machine with atomic claims and stale-result rejection.
 * Operator model: planner always runs on the primary model. No wall-clock lease kills the attempt
 * (subscription models rarely "timeout" as product policy — if Task fails, treat as real failure).
 * No model fallback ladder: provider death → delivery-blocked for operator, not silent model swap.
 */

import crypto from "node:crypto";
import { AGENT_RETRY_K } from "../../../shared/lib/agent-retry.mjs";

/**
 * Per-process instance tag (mirrors marker-seal.mjs's per-process secret). This plugin's
 * in-memory state does not survive a process restart, so a Task claimed by a PRIOR instance
 * can never complete it — the claim is dead, not merely slow. Stamped onto every claim and
 * compared on the next one so a dead claim can be reconciled under lock instead of blocking
 * every future dispatch forever (no wall-clock kill applies here either).
 */
const PROCESS_INSTANCE = crypto.randomUUID();

/** @deprecated Kept for test/compat imports; lease expiry no longer kills attempts. */
export const PLANNER_ATTEMPT_LEASE_MS = Number.POSITIVE_INFINITY;
/** @deprecated Kept for test/compat imports; write window is not time-killed. */
export const PLAN_WRITE_LEASE_MS = Number.POSITIVE_INFINITY;

/**
 * Failure-retry budget (K=3) for ONE planning round — an unparseable plan, a rejected envelope, a
 * provider blip. It is NOT the revision budget: a plan-review REVISE is an instruction to re-plan
 * (progress), so `applyReviewOutcome` credits a fresh round budget when it persists one. Conflating
 * the two is what deadlocked a live run at plan_review_count 2 of 5 — the review budget was never
 * reachable because each round spent one of these three.
 */
export const MAX_PRIMARY_ATTEMPTS = AGENT_RETRY_K;

/** @description Trusted reset applied only by a successful explicit classify cycle. */
export function plannerCycleResetPatch() {
  return {
    planner_status: "not_started",
    planner_retry_outcome: null,
    planner_failure_class: null,
    planner_primary_attempts: 0,
    // Cleared so a verified restart cannot inherit a stale round stamp and skip its round credit
    // (a stamp of 2 would silently refuse the credit for rounds 1 and 2 of the restarted cycle).
    planner_attempts_round: 0,
    planner_fallback_attempts: 0,
    planner_fallback_result: null,
    planner_fallback_diagnostic: null,
    planner_active_attempt: null,
    planner_last_attempt: null,
    planner_plan_binding: null,
    planner_binding_error: null,
    agent_dispatch_failures: {},
    agent_dispatch_last_failure: null,
    delivery_status: "planning",
  };
}

function objectState(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * @description Lease reconciliation is intentionally a no-op.
 * Wall-clock expiry must not kill a live planner Task or force model fallback —
 * the operator runs a subscribed primary model; slow ≠ dead.
 */
export function reconcilePlannerLease(previous, _input = {}) {
  return { state: { ...objectState(previous) }, reconciled: false };
}

/** @description Atomically claim a primary or one-shot fallback attempt using callID + random token. */
export function claimPlannerAttempt(previous, input = {}) {
  const reconciled = reconcilePlannerLease(previous, input);
  let state = reconciled.state;
  const role = input.role;
  if (state.planner_active_attempt) {
    const active = objectState(state.planner_active_attempt);
    // Idempotent re-entry: OC 1.18 can invoke tool.execute.before twice for the same Task
    // (plugin listed in opencode.json plugin[] AND auto-loaded from .opencode/plugin/). Same
    // callID already owns the lease — allow without consuming another primary/fallback attempt.
    if (
      typeof input.callId === "string" &&
      input.callId &&
      active.call_id === input.callId &&
      (input.sessionId == null || active.session_id === input.sessionId) &&
      (role == null || active.role === role)
    ) {
      return { ok: true, state, reconciled: reconciled.reconciled, idempotent: true };
    }
    if (active.process_instance === PROCESS_INSTANCE) {
      return { ok: false, reason: "planner attempt already active", state };
    }
    // Dead claim: it belongs to a process instance that is no longer this one, so the Task it
    // claimed can never complete or fail it (that boundary died with the prior process too).
    // Reconcile it under this same lock instead of blocking every future dispatch forever, and
    // instead of leaving it to silently swallow a late result as "stale" once a fresh claim wins.
    state = {
      ...state,
      planner_active_attempt: null,
      planner_last_attempt: { ...active, failed_at: input.now, reconciled_reason: "dead claim: prior process instance" },
    };
  }
  if (
    state.planner_retry_outcome === "fallback_failed" ||
    state.planner_status === "planner_failed" ||
    state.delivery_status === "delivery-blocked"
  ) {
    return { ok: false, reason: "planner cycle is terminal; explicit classify reset required", state };
  }
  if (typeof input.callId !== "string" || !input.callId || typeof input.token !== "string" || !input.token) {
    return { ok: false, reason: "planner claim requires callID and token", state };
  }
  // Planner is primary-only. Fallback agent is disabled as a recovery ladder.
  if (role === "planner-fallback") {
    return {
      ok: false,
      reason: "planner fallback disabled — retry primary planner or stop (delivery-blocked on real provider death)",
      state,
    };
  }
  if (Number(state.planner_primary_attempts ?? 0) >= MAX_PRIMARY_ATTEMPTS) {
    return {
      ok: false,
      reason:
        `planner budget for this review round is spent (${MAX_PRIMARY_ATTEMPTS} attempts). Do NOT re-dispatch the planner ` +
        "now — the next attempt is refused. Every writing hand MUST keep waiting while plan_verdict is REVISE (your " +
        "obligation, not a runtime gate — #483), so this run cannot proceed on its own: report the blocking finding to " +
        "the operator in product language and stop. A new round budget is credited only when a plan-review round " +
        "persists a fresh REVISE.",
      state,
    };
  }
  state.planner_primary_attempts = Number(state.planner_primary_attempts ?? 0) + 1;
  state.planner_primary_model = input.model;
  state.planner_status = "running";
  state.delivery_status = "planning";
  state.planner_active_attempt = {
    call_id: input.callId,
    token: input.token,
    role: role === "planner" || !role ? "planner" : role,
    session_id: input.sessionId,
    feature_id: input.featureId,
    model: input.model,
    started_at: input.now,
    // No wall-clock kill — claim stays until complete/fail/bind.
    expires_at: null,
    baseline_plan: input.baselinePlan ?? null,
    process_instance: PROCESS_INSTANCE,
  };
  return { ok: true, state, reconciled: reconciled.reconciled };
}

/** @description Persist a successful/invalid output only when it belongs to the current claim. */
export function completePlannerAttempt(previous, input = {}) {
  const state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  if (active.call_id !== input.callId || active.token !== input.token) {
    return { ok: true, accepted: false, reason: "stale planner result", state };
  }
  state.planner_last_attempt = { ...active, completed_at: input.now };
  if (input.resultKind === "usable_plan") {
    state.planner_status = "plan_pending_write";
    state.delivery_status = "planning";
    state.planner_active_attempt = {
      ...active,
      status: "plan_returned",
      returned_plan_hash: input.planHash,
      completed_at: input.now,
      expires_at: null,
    };
    return { ok: true, accepted: true, state };
  }
  state.planner_active_attempt = null;
  // Invalid plan from primary → revision loop (REVISE), not model fallback.
  state.planner_status = "plan_invalid";
  state.planner_invalid_errors = input.errors ?? ["invalid plan"];
  state.planner_retry_outcome = "not_applicable";
  state.delivery_status =
    Number(state.planner_primary_attempts) >= MAX_PRIMARY_ATTEMPTS
      ? "delivery-blocked"
      : "planning_revision";
  return { ok: true, accepted: true, state };
}

/** @description Persist a structured boundary rejection only for the current callID/token. */
export function failPlannerAttempt(previous, input = {}) {
  const state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  if (active.call_id !== input.callId || (input.token && active.token !== input.token)) {
    return { ok: true, accepted: false, reason: "stale planner failure", state };
  }
  state.planner_active_attempt = null;
  state.planner_last_attempt = { ...active, failed_at: input.now };
  state.planner_failure_class = input.failureClass;
  // Primary-only: any Task boundary failure is a product stop, not a model ladder.
  // Conductor may re-dispatch primary planner while under MAX_PRIMARY_ATTEMPTS and not terminal.
  if (input.providerUnavailable === true) {
    state.planner_status = "planner_unavailable";
    state.planner_retry_outcome = "fallback_unavailable";
    state.planner_fallback_diagnostic =
      "planner model fallback disabled — retry primary or stop; treat as product/provider outage";
    state.delivery_status =
      Number(state.planner_primary_attempts) >= MAX_PRIMARY_ATTEMPTS
        ? "delivery-blocked"
        : "planning_revision";
    return { ok: true, accepted: true, state };
  }
  state.planner_status = "planner_failed";
  state.planner_retry_outcome = "not_applicable";
  state.delivery_status = "delivery-blocked";
  return { ok: true, accepted: true, state };
}

/** @description Promote only a fresh canonical artifact matching the current returned plan and claim. */
export function bindPlannerArtifact(previous, input = {}) {
  const state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  if (state.planner_status !== "plan_pending_write" || active.status !== "plan_returned") {
    return { ok: false, reason: "no current returned planner attempt", state };
  }
  if (active.session_id !== input.sessionId || active.feature_id !== input.featureId) {
    return { ok: false, reason: "plan session/feature does not match planner claim", state };
  }
  if (input.artifact?.plan?.feature_id !== active.feature_id) {
    return { ok: false, reason: "canonical plan feature_id does not match planner claim", state };
  }
  if (!input.artifact?.valid || input.artifact.semanticHash !== active.returned_plan_hash) {
    return { ok: false, reason: "canonical plan content does not match returned plan", state };
  }
  const baseline = objectState(active.baseline_plan);
  if (baseline.fingerprint && baseline.fingerprint === input.artifact.fingerprint) {
    return { ok: false, reason: "canonical plan was not rewritten by current attempt", state };
  }
  state.planner_status = "usable";
  state.planner_retry_outcome = "not_needed";
  state.delivery_status = "planning";
  // A rejection string from an earlier attempt outlived its attempt: a live gate-state showed
  // planner_status "usable" with a valid binding NEXT TO "returned plan feature_id does not match
  // the session feature". Anyone reading that concludes there is no plan and re-runs the planner.
  state.planner_binding_error = null;
  state.planner_plan_binding = {
    call_id: active.call_id,
    token: active.token,
    session_id: active.session_id,
    feature_id: active.feature_id,
    model: active.model,
    semantic_hash: input.artifact.semanticHash,
    file_hash: input.artifact.fileHash,
    fingerprint: input.artifact.fingerprint,
    mtime_ms: input.artifact.mtimeMs,
    size: input.artifact.size,
  };
  state.planner_active_attempt = null;
  return { ok: true, state };
}

export default {
  bindPlannerArtifact,
  claimPlannerAttempt,
  completePlannerAttempt,
  failPlannerAttempt,
  plannerCycleResetPatch,
  reconcilePlannerLease,
};
