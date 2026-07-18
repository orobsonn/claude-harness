/** @description Pure planner attempt state machine with bounded atomic claims, leases, and stale-result rejection. */

export const PLANNER_ATTEMPT_LEASE_MS = 5 * 60_000;
export const PLAN_WRITE_LEASE_MS = 60_000;
export const MAX_PRIMARY_ATTEMPTS = 3;

/** @description Trusted reset applied only by a successful explicit classify cycle. */
export function plannerCycleResetPatch() {
  return {
    planner_status: "not_started",
    planner_retry_outcome: null,
    planner_failure_class: null,
    planner_primary_attempts: 0,
    planner_fallback_attempts: 0,
    planner_fallback_result: null,
    planner_fallback_diagnostic: null,
    planner_active_attempt: null,
    planner_last_attempt: null,
    planner_plan_binding: null,
    planner_binding_error: null,
    delivery_status: "planning",
  };
}

function objectState(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @description Resolve an expired active claim to a bounded terminal/recovery state. */
export function reconcilePlannerLease(previous, input = {}) {
  const state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  const now = Number(input.now);
  if (!active.call_id || !Number.isFinite(now) || !Number.isFinite(Number(active.expires_at)) || now < Number(active.expires_at)) {
    return { state, reconciled: false };
  }
  state.planner_active_attempt = null;
  state.planner_failure_class = "timeout";
  if (active.role === "planner-fallback") {
    state.planner_status = "planner_unavailable";
    state.planner_fallback_result = "lease_expired";
    state.planner_retry_outcome = "fallback_failed";
    state.delivery_status = "delivery-blocked";
  } else {
    const hasFallback = input.hasFallback === true;
    state.planner_status = "planner_unavailable";
    state.planner_retry_outcome = hasFallback ? "fallback_pending" : "fallback_unavailable";
    state.delivery_status = hasFallback ? "planning_recovery" : "delivery-blocked";
    if (!hasFallback) state.planner_fallback_diagnostic = input.fallbackDiagnostic ?? "planner fallback unavailable";
  }
  return { state, reconciled: true };
}

/** @description Atomically claim a primary or one-shot fallback attempt using callID + random token. */
export function claimPlannerAttempt(previous, input = {}) {
  const reconciled = reconcilePlannerLease(previous, input);
  const state = reconciled.state;
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
    return { ok: false, reason: "planner attempt already active", state };
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
  if (role === "planner-fallback") {
    if (state.planner_status !== "planner_unavailable" || state.planner_retry_outcome !== "fallback_pending") {
      return { ok: false, reason: "fallback requires pending primary provider failure", state };
    }
    if (Number(state.planner_fallback_attempts ?? 0) >= 1) {
      return { ok: false, reason: "planner fallback attempt already consumed", state };
    }
    state.planner_fallback_attempts = 1;
    state.planner_fallback_model = input.model;
  } else {
    if (state.planner_status === "planner_unavailable" && state.planner_retry_outcome === "fallback_pending") {
      return { ok: false, reason: "primary unavailable; configured fallback is required", state };
    }
    if (Number(state.planner_primary_attempts ?? 0) >= MAX_PRIMARY_ATTEMPTS) {
      return { ok: false, reason: "planner primary attempt bound reached", state };
    }
    state.planner_primary_attempts = Number(state.planner_primary_attempts ?? 0) + 1;
    state.planner_primary_model = input.model;
  }
  state.planner_status = "running";
  state.delivery_status = "planning";
  state.planner_active_attempt = {
    call_id: input.callId,
    token: input.token,
    role,
    session_id: input.sessionId,
    feature_id: input.featureId,
    model: input.model,
    started_at: input.now,
    expires_at: Number(input.now) + PLANNER_ATTEMPT_LEASE_MS,
    baseline_plan: input.baselinePlan ?? null,
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
      expires_at: Number(input.now) + PLAN_WRITE_LEASE_MS,
    };
    return { ok: true, accepted: true, state };
  }
  state.planner_active_attempt = null;
  if (active.role === "planner-fallback") {
    state.planner_status = "planner_unavailable";
    state.planner_fallback_result = "invalid_plan";
    state.planner_retry_outcome = "fallback_failed";
    state.delivery_status = "delivery-blocked";
  } else {
    state.planner_status = "plan_invalid";
    state.planner_invalid_errors = input.errors ?? ["invalid plan"];
    state.planner_retry_outcome = "not_applicable";
    state.delivery_status = Number(state.planner_primary_attempts) >= MAX_PRIMARY_ATTEMPTS ? "delivery-blocked" : "planning_revision";
  }
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
  if (input.providerUnavailable !== true) {
    state.planner_status = "planner_failed";
    state.planner_retry_outcome = "not_applicable";
    state.delivery_status = "delivery-blocked";
    return { ok: true, accepted: true, state };
  }
  state.planner_status = "planner_unavailable";
  if (active.role === "planner-fallback") {
    state.planner_fallback_result = input.failureClass;
    state.planner_retry_outcome = "fallback_failed";
    state.delivery_status = "delivery-blocked";
  } else {
    const hasFallback = input.hasFallback === true;
    state.planner_retry_outcome = hasFallback ? "fallback_pending" : "fallback_unavailable";
    state.delivery_status = hasFallback ? "planning_recovery" : "delivery-blocked";
    if (!hasFallback) state.planner_fallback_diagnostic = input.fallbackDiagnostic ?? "planner fallback unavailable";
  }
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
  state.planner_retry_outcome = active.role === "planner-fallback" ? "fallback_succeeded" : "not_needed";
  if (active.role === "planner-fallback") state.planner_fallback_result = "succeeded";
  state.delivery_status = "planning";
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
