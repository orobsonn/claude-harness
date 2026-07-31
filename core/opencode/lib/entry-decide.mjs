/** @description Pure entry-gate decisions for OC (ceremony + fidelity). Never throws; returns Decision. */

import {
  bareRole,
  isDeliveryRole,
  isExecutorRole,
  isSniperRole,
  isPlannerRole,
  isTestAuthorRole,
  isAdversaryRole,
} from "./roles.mjs";
import { absolutionPrefix, matchesAbsolution } from "../../shared/lib/absolution.mjs";
import { classifyRegatePending, corruptRegatePendingReason } from "../../shared/lib/regate-classify.mjs";

/**
 * @typedef {{ ok: boolean, decision: "allow"|"deny"|"warn", reason: string, details?: unknown }} Decision
 */

/**
 * @description Whether fidelity_pass contains an entry for feature/task (prefix match, optional
 * @sha). Two granularities, both still needed by different callers: pass `taskId` for an EXACT
 * `feature/task` match (run-hand.mjs's cheap-hand spawn rail — mirrors Claude Code entry-gate.mjs's
 * decideBash spawn-hand.mjs check, which requires the SPECIFIC task's own red test before spawning
 * that task's hand); omit `taskId` for a FEATURE-level match, i.e. any task of the same feature
 * counts (decideEntryTask's Task-dispatch executor rail below — mirrors Claude Code entry-gate.mjs's
 * headless-executor check, `id.startsWith(`${featureId}/`)`), which is what unblocks a fresh
 * fix-mode session's executor re-dispatch (its own fidelity_pass is empty, but a sibling task under
 * the same feature already has one).
 * @param {unknown} fidelityPass
 * @param {string} featureId
 * @param {string} [taskId]
 * @returns {boolean}
 */
export function hasFidelityPass(fidelityPass, featureId, taskId) {
  if (!Array.isArray(fidelityPass) || typeof featureId !== "string" || !featureId) {
    return false;
  }
  for (const entry of fidelityPass) {
    if (typeof entry !== "string") continue;
    const base = absolutionPrefix(entry);
    if (typeof taskId === "string" && taskId.length > 0) {
      if (base === `${featureId}/${taskId}`) return true;
    } else if (base === featureId || base.startsWith(`${featureId}/`)) {
      return true;
    }
  }
  return false;
}

/**
 * @description Decide whether a task subagent dispatch is allowed.
 * Gate 1: every delivery role (including executor/sniper) requires mode LIGHT or FULL — mirrors
 * Claude Code entry-gate.mjs's triage-mode check, which has no per-role exemption.
 * Planner ceremony: brainstormed + adversary_fired, bound to the dispatched feature.
 * Fidelity rail: executor blocked until a feature-level fidelity_pass exists; test-author and
 * sniper are always exempt.
 * Gate 3: shipper blocked while any regate_pending has no matching regate_passed. Matching is
 * prefix-only unless `input.isAncestorFn` is supplied, in which case it upgrades to the exact
 * sha/ancestor-of-HEAD check Claude Code performs (entry-gate.ts does not currently thread this).
 * `taskId` is accepted for caller compatibility (entry-gate.ts still threads it) but no longer
 * affects the decision — fidelity and re-gate matching are both feature-scoped.
 * @param {{
 *   subagentType?: unknown,
 *   gateState?: unknown,
 *   mode?: unknown,
 *   featureId?: unknown,
 *   dispatchFeatureId?: unknown,
 *   taskId?: unknown,
 *   isAncestorFn?: (sha: string) => boolean | null,
 * }} input
 * @returns {Decision}
 */
export function decideEntryTask(input = {}) {
  try {
    const sub = bareRole(input.subagentType);
    if (!sub || !isDeliveryRole(sub)) {
      return { ok: true, decision: "allow", reason: "non-delivery-role" };
    }

    const gs =
      input.gateState && typeof input.gateState === "object" && !Array.isArray(input.gateState)
        ? /** @type {Record<string, unknown>} */ (input.gateState)
        : {};

    const classified = gs.classified === true || gs.triaged === true;
    const modeNorm = typeof gs.mode === "string" ? gs.mode.trim().toLowerCase() : "";

    // Gate 1 (CC parity, entry-gate.mjs:819-842): EVERY delivery role — including executor and
    // sniper — dispatches ONLY under mode LIGHT or FULL. Claude Code has no per-role exemption
    // here; QUICK/no-ceremony never reach a delivery-agent Task dispatch on the CC side (QUICK
    // implements inline, per core/CLAUDE.md), so a QUICK-stamped executor/sniper dispatch on OC
    // must deny exactly like every other delivery role, not just the four eyes.
    if (modeNorm !== "light" && modeNorm !== "full") {
      if (!classified && !modeNorm) {
        return {
          ok: false,
          decision: "deny",
          reason:
            "[entry-gate] Blocked: ceremony missing — run oc-triaging-requests and classify before dispatching delivery agents.",
        };
      }
      return {
        ok: false,
        decision: "deny",
        reason:
          `[entry-gate] Blocked: mode '${typeof gs.mode === "string" ? gs.mode : "(none)"}' forbids ${sub} — ` +
          "run oc-triaging-requests and classify (choosing mode LIGHT or FULL) BEFORE dispatching any delivery agent.",
      };
    }

    // Planner ceremony: brainstormed + adversary_fired
    if (isPlannerRole(sub)) {
      // dispatchFeatureId is what THIS dispatch declares, kept independent of gs.feature_id by
      // the caller (entry-gate.ts) — comparing gs.feature_id against a value the caller already
      // collapsed into gs.feature_id itself would make this check an unreachable tautology.
      const plannerFeatureId = typeof input.dispatchFeatureId === "string" ? input.dispatchFeatureId : "";
      // Bind the ceremony flags to the feature being planned: a gate-state stamped for a
      // DIFFERENT feature carries stale brainstormed/adversary_fired from a prior feature in
      // the same session. Mirrors Claude Code entry-gate.mjs featureMismatch (entry-gate.mjs:944-947) —
      // treat that as ceremony-not-done and re-instruct for this feature.
      const featureMismatch =
        typeof gs.feature_id === "string" && gs.feature_id !== "" &&
        plannerFeatureId !== "" && gs.feature_id !== plannerFeatureId;
      if (featureMismatch || gs.brainstormed !== true) {
        return {
          ok: false,
          decision: "deny",
          reason: `[entry-gate] ${JSON.stringify({ code: "CEREMONY_PROOF_REQUIRED", missing_proof: "brainstorming_completion_evidence", next_transition: { phase: "brainstorming", action: "resume", marker: "brainstormed" } })}`,
        };
      }
      if (gs.adversary_fired !== true) {
        return {
          ok: false,
          decision: "deny",
          reason: `[entry-gate] ${JSON.stringify({ code: "CEREMONY_PROOF_REQUIRED", missing_proof: "spec_adversary_completion_evidence", next_transition: { phase: "spec-adversary", action: "resume", marker: "adversary_fired" } })}`,
        };
      }
    }

    // Adversary dispatch is allowed once ceremony is present (caller stamps adversary_fired)
    if (isAdversaryRole(sub)) {
      return { ok: true, decision: "allow", reason: "adversary-allowed" };
    }

    // Fidelity rail: test-author and sniper are EXEMPT (mirrors Claude Code entry-gate.mjs, which
    // never gates test-author's own fidelity output and unconditionally allows the sniper in
    // headless — sniper is the POST-gate fixer dispatched precisely because something already
    // went wrong; it must never wait on the same fidelity-pass its own fix may be producing).
    // Only the executor consumer is gated, and at FEATURE granularity (hasFidelityPass — see its
    // docstring): this is the second fix-mode wall (a sniper re-dispatch for the SAME feature but
    // a fresh session has an empty fidelity_pass and must not be blocked by it).
    if (isTestAuthorRole(sub)) {
      return { ok: true, decision: "allow", reason: "test-author-fidelity-exempt" };
    }

    if (isSniperRole(sub)) {
      return { ok: true, decision: "allow", reason: "sniper-fidelity-exempt" };
    }

    if (isExecutorRole(sub)) {
      const featureId =
        typeof input.featureId === "string"
          ? input.featureId
          : typeof gs.feature_id === "string"
            ? gs.feature_id
            : "";
      if (!hasFidelityPass(gs.fidelity_pass, featureId)) {
        return {
          ok: false,
          decision: "deny",
          reason: `[entry-gate] Blocked: executor requires fidelity-pass for feature '${featureId}' before spawn; dispatch test-author first.`,
          details: { featureId },
        };
      }
    }

    // Gate 3 (CC parity, entry-gate.mjs:993-1028): shipper is the deterministic CONSUMER of the
    // re-gate rail. A HIGH sniper fix stamps regate_pending; the mandatory strong-eye re-gate
    // stamps regate_passed. An unmatched regate_pending denies the shipper dispatch — the same
    // corrupt/unmatched checks the bash delivery gate (bash-decide.mjs) already runs at push time.
    // isAncestorFn is OPTIONAL here (entry-gate.ts does not currently thread it into this call):
    // when absent, matching falls back to PREFIX-only (ignores sha/ancestor-of-HEAD freshness) —
    // an early, dispatch-time advisory rail to avoid spawning a shipper that would fail at push
    // anyway, with bash-decide.mjs remaining the freshness-strict, authoritative enforcement point
    // at push time. When a real isAncestorFn IS supplied, this upgrades to the exact same
    // matchesAbsolution sha/ancestor check Claude Code performs, closing the gap for free.
    if (bareRole(input.subagentType) === "shipper") {
      const regate = classifyRegatePending(gs);
      if (regate.corrupt) {
        return { ok: false, decision: "deny", reason: corruptRegatePendingReason(regate.raw) };
      }
      const passedArr = Array.isArray(gs.regate_passed)
        ? gs.regate_passed.filter((entry) => typeof entry === "string")
        : [];
      const isAncestorFn = typeof input.isAncestorFn === "function" ? input.isAncestorFn : null;
      const passedPrefixes = isAncestorFn ? null : new Set(passedArr.map(absolutionPrefix));
      const unmatched = regate.pending.filter((t) => {
        if (typeof t !== "string") return true;
        return isAncestorFn
          ? !matchesAbsolution(t, passedArr, isAncestorFn)
          : !passedPrefixes.has(t);
      });
      if (unmatched.length > 0) {
        return {
          ok: false,
          decision: "deny",
          reason:
            `[entry-gate] Blocked: HIGH sniper fix(es) for task(s) ${unmatched.join(", ")} still ` +
            "await the mandatory strong-eye re-gate (regate-pending without regate-passed). " +
            "Dispatch the fresh-virgin adversary and stamp regate-passed before dispatching the shipper.",
        };
      }
    }

    return { ok: true, decision: "allow", reason: "entry-allow" };
  } catch (err) {
    // Drive-by catch-all: an unexpected internal error here is an entry-gate bug, not evidence
    // the dispatch itself is unsafe. Fail-open like the rest of the OC entry-gate (#482) — deny
    // dead-ends the run over a decision-logic fault the operator cannot fix from the prompt.
    console.error(
      `[entry-gate] entry decision failed unexpectedly, allowing dispatch: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {
      ok: true,
      decision: "allow",
      reason: "[entry-gate] entry decision failed unexpectedly — allow-with-log (fail-open)",
    };
  }
}

/**
 * @description Map Decision to throw for OC plugin (fail-closed).
 * @param {Decision} decision
 * @returns {void}
 * @throws {Error} when decision is deny
 */
export function throwIfDenied(decision) {
  if (decision && decision.decision === "deny") {
    throw new Error(decision.reason || "[entry-gate] denied");
  }
}
