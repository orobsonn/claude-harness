/** @description Identity-bound planner lifecycle; it never enforces retry or review budgets. */
import crypto from "node:crypto";
import { isCompleteExpectedModelStrategy } from "../../shared/lib/model-strategy-projection.mjs";

const PROCESS_INSTANCE = crypto.randomUUID();

function objectState(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** @description Resets planner identity and canonical-artifact binding on a new classify cycle. */
export function plannerCycleResetPatch() {
  return {
    planner_status: "not_started",
    planner_active_attempt: null,
    planner_last_attempt: null,
    planner_plan_binding: null,
    planner_binding_error: null,
  };
}

/** @description Claims one active planner call; a repeated host hook for that call is idempotent. */
export function claimPlannerAttempt(previous, input = {}) {
  let state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  if (active.call_id) {
    if (active.call_id === input.callId && active.session_id === input.sessionId) {
      return { ok: true, state, idempotent: true };
    }
    state = {
      ...state,
      planner_active_attempt: null,
      planner_last_attempt: { ...active, ended_reason: "superseded by a later planner call" },
    };
  }
  if (input.role && input.role !== "planner") {
    return { ok: false, reason: "only the configured planner owns canonical planning", state };
  }
  if (typeof input.callId !== "string" || !input.callId || typeof input.token !== "string" || !input.token) {
    return { ok: false, reason: "planner claim requires session call identity", state };
  }
  state = {
    ...state,
    planner_status: "running",
    planner_binding_error: null,
    planner_active_attempt: {
      call_id: input.callId,
      token: input.token,
      session_id: input.sessionId,
      feature_id: input.featureId,
      model: input.model,
      baseline_plan: input.baselinePlan ?? null,
      expected_model_strategy: input.expectedModelStrategy,
      process_instance: PROCESS_INSTANCE,
    },
  };
  return { ok: true, state };
}

/** @description Accepts a result only from the current planner call identity. */
export function completePlannerAttempt(previous, input = {}) {
  const state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  if (active.call_id !== input.callId || active.token !== input.token) {
    return { ok: true, accepted: false, reason: "stale planner result", state };
  }
  if (input.resultKind !== "usable_plan") {
    return {
      ok: true,
      accepted: true,
      state: {
        ...state,
        planner_status: "plan_invalid",
        planner_invalid_errors: input.errors ?? ["invalid plan"],
        planner_last_attempt: { ...active, result: "invalid" },
        planner_active_attempt: null,
      },
    };
  }
  return {
    ok: true,
    accepted: true,
    state: {
      ...state,
      planner_status: "plan_pending_write",
      planner_active_attempt: { ...active, returned_plan_hash: input.planHash },
    },
  };
}

/** @description Records a terminal provider boundary only when it belongs to the current call. */
export function failPlannerAttempt(previous, input = {}) {
  const state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  if (active.call_id !== input.callId || input.token && active.token !== input.token) {
    return { ok: true, accepted: false, reason: "stale planner failure", state };
  }
  return {
    ok: true,
    accepted: true,
    state: {
      ...state,
      planner_status: "planner_failed",
      planner_last_attempt: { ...active, result: "failed" },
      planner_active_attempt: null,
    },
  };
}

/** @description Binds only a fresh canonical artifact to its matching session and feature identity. */
export function bindPlannerArtifact(previous, input = {}) {
  const state = { ...objectState(previous) };
  const active = objectState(state.planner_active_attempt);
  const artifact = input.artifact;
  if (state.planner_status !== "plan_pending_write" || !active.call_id) {
    return { ok: false, reason: "no returned planner call to bind", state };
  }
  if (active.session_id !== input.sessionId || active.feature_id !== input.featureId || artifact?.plan?.feature_id !== input.featureId) {
    return { ok: false, reason: "canonical plan identity does not match planner call", state };
  }
  if (!artifact?.valid || artifact.semanticHash !== active.returned_plan_hash) {
    return { ok: false, reason: "canonical plan content does not match planner result", state };
  }
  if (!isCompleteExpectedModelStrategy(input.expectedModelStrategy)) {
    return { ok: false, reason: "canonical plan binding requires the frozen model strategy", state };
  }
  if (active.baseline_plan?.fingerprint && active.baseline_plan.fingerprint === artifact.fingerprint) {
    return { ok: false, reason: "planner returned the canonical plan unchanged", state };
  }
  return {
    ok: true,
    state: {
      ...state,
      planner_status: "usable",
      planner_active_attempt: null,
      planner_last_attempt: { ...active, result: "bound" },
      planner_binding_error: null,
      planner_plan_binding: {
        call_id: active.call_id,
        session_id: active.session_id,
        feature_id: active.feature_id,
        semantic_hash: artifact.semanticHash,
        file_hash: artifact.fileHash,
        fingerprint: artifact.fingerprint,
        expected_model_strategy: input.expectedModelStrategy,
      },
    },
  };
}

export default {
  bindPlannerArtifact,
  claimPlannerAttempt,
  completePlannerAttempt,
  failPlannerAttempt,
  plannerCycleResetPatch,
};
