/**
 * @description ADR-003 dual/plan_verdict classification helpers (record-only since #483).
 * Generic utils (isTaskTool, extractSubagentType, extractHookTaskContext,
 * isSafeSessionIdSegment, loadGateStateFromDisk) live in task-dispatch-identity /
 * hook-identity / gate-state and are re-exported here (#580). plan-gate still calls
 * enforceDualFromDiskOrThrow until #583 removes the dual block; entry-gate does not.
 * decideDualBeforeDelivery never denies a delivery hand (executor/sniper), mirroring Claude
 * Code. A pending/missing dual_status, a non-APPROVE plan_verdict, or an unreadable/corrupt
 * gate-state all resolve to allow. `details` still reports dual_status / plan_verdict /
 * isFullDualCoverage / requireDualOn for observability (incl. routing-v1 + unreadable warns).
 * Discipline around waiting for plan-review APPROVE before dispatching a writing hand is
 * prose + orchestration (see lib/revise-nudge.mjs). Recording dual_status/plan_verdict is a
 * separate writer path (dual-merge.mjs / dual-nudge.mjs).
 * Pure Decision returns — never throws. Role matching is case-insensitive.
 * dualStatusGatePatch / dualStatusGatePatchForPhase are the only allowed dual_status
 * writer shapes (enum only). No Map-only state.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DUAL_STATUS,
  isFullDualCoverage,
  isRecordedDualAttempt,
  isDualStatusEnum,
  dualStatusGatePatch,
  dualStatusGatePatchForPhase,
  dualStatusPhaseFromRole,
  normalizeDualStatusMap,
  readDualStatus as readDualStatusFromShape,
  validateGateStateDualFields,
} from "../../../shared/lib/gate-state-shape.mjs";
import { adaptRoutingV1 } from "../../../shared/lib/routing-adapter.mjs";
import { validateRouting } from "../../../shared/lib/routing-validate.mjs";
import {
  isTaskTool,
  extractSubagentType,
} from "./task-dispatch-identity.mjs";
import { extractHookTaskContext } from "./hook-identity.mjs";
import {
  isSafeSessionIdSegment,
  loadGateStateFromDisk,
} from "./gate-state.mjs";

export {
  isTaskTool,
  extractSubagentType,
  extractHookTaskContext,
  isSafeSessionIdSegment,
  loadGateStateFromDisk,
};

const warnedLegacyRoutingPaths = new Set();

/** Default requireDualOn roles (ADR-003). */
export const DEFAULT_REQUIRE_DUAL_ON = Object.freeze([
  "plan-reviewer",
  "adversary",
]);

/**
 * Delivery hand subagent types that require a recorded dual attempt before dispatch
 * when requireDualOn is configured (dual_status_required_before_executor).
 * test-author is exempt (produces fidelity; not a dual post consumer).
 * Matched case-insensitively via bareSubagentType lowercasing.
 */
/** Matched against bareSubagentType() which is already lowercased. */
const DELIVERY_HAND_PATTERN =
  /^(executor|sniper)(-low|-medium|-high|-max)?(-spawn)?$/;

/**
 * @description Normalize subagent_type to bare role (strip namespace prefix, lowercase).
 * Case-insensitive so Executor-High cannot bypass dual enforcement.
 * @param {unknown} subagentType
 * @returns {string}
 */
export function bareSubagentType(subagentType) {
  if (typeof subagentType !== "string") return "";
  const s = subagentType.trim();
  if (!s) return "";
  // Strip namespace prefix (harness:executor-high → executor-high), then lowercase
  // so Executor-High cannot bypass dual enforcement.
  const bare = s.includes(":") ? s.slice(s.lastIndexOf(":") + 1) : s;
  return bare.toLowerCase();
}

/**
 * @description Whether subagent is an executor/sniper delivery hand that must wait for dual.
 * Case-insensitive (Executor-High === executor-high).
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isDeliveryHandRequiringDual(subagentType) {
  const bare = bareSubagentType(subagentType);
  return bare.length > 0 && DELIVERY_HAND_PATTERN.test(bare);
}

/**
 * @description Read requireDualOn list from harness.routing.json shape.
 * Source: constraints.requireDualOn. Never throws.
 * @param {unknown} routing
 * @returns {string[]}
 */
export function readRequireDualOn(routing) {
  try {
    if (
      routing == null ||
      typeof routing !== "object" ||
      Array.isArray(routing)
    ) {
      return [];
    }
    const constraints =
      /** @type {Record<string, unknown>} */ (routing).constraints;
    if (
      constraints == null ||
      typeof constraints !== "object" ||
      Array.isArray(constraints)
    ) {
      // Single-evaluator default: no constraints ⇒ dual not required.
      // Legacy families shape still carries explicit requireDualOn after v1 adapt.
      return [];
    }
    const list =
      /** @type {Record<string, unknown>} */ (constraints).requireDualOn;
    if (!Array.isArray(list) || list.length === 0) {
      return [];
    }
    return list.filter((r) => typeof r === "string" && r.length > 0);
  } catch {
    return [];
  }
}

/**
 * @description Whether routing requires dual on at least one ADR-003 post.
 * @param {unknown} routing
 * @returns {boolean}
 */
export function routingRequiresDual(routing) {
  const roles = readRequireDualOn(routing);
  return roles.includes("plan-reviewer") || roles.includes("adversary");
}

/**
 * @description Extract dual_status for a phase from gate-state. Never throws.
 * Default phase is plan_review (executor / delivery path).
 * Legacy scalar dual_status string counts as plan_review only — adversary phase
 * returns undefined (fail-closed for task-adversary precondition).
 * @param {unknown} gateState
 * @param {"plan_review" | "adversary"} [phase="plan_review"]
 * @returns {string | undefined}
 */
export function readDualStatus(gateState, phase = "plan_review") {
  return readDualStatusFromShape(gateState, phase);
}

/**
 * @description Extract plan_verdict from gate-state (APPROVE | REVISE). Never throws.
 * dual_status alone must not unlock delivery hands after a REVISE plan-review.
 * @param {unknown} gateState
 * @returns {"APPROVE" | "REVISE" | undefined}
 */
export function readPlanVerdict(gateState) {
  try {
    if (
      gateState == null ||
      typeof gateState !== "object" ||
      Array.isArray(gateState)
    ) {
      return undefined;
    }
    const v = /** @type {Record<string, unknown>} */ (gateState).plan_verdict;
    if (typeof v !== "string") return undefined;
    const s = v.trim().toUpperCase();
    if (s === "APPROVE") return "APPROVE";
    if (s === "REVISE") return "REVISE";
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * @description Classify dual_status/plan_verdict for a delivery hand dispatch. Record-only
 * (#483) — never denies. Kept as a rich classifier (rather than collapsing to one generic
 * "allow") because `details` is what a caller logs or feeds to a prose nudge; the branches
 * below preserve which distinct condition was observed (missing/pending/invalid/REVISE/…)
 * even though every one of them now resolves to "allow".
 *
 * Rules (resolved_judgments, #483 supersedes the #482-era deny rules below with allow):
 * - dual_status_required_before_executor: false (record-only)
 * - pending_blocks_executor: false (record-only)
 * - plan_verdict_revise_blocks_executor: false (record-only)
 * - bare_boolean_dual_completed_rejected: false (record-only; still flagged in `reason`)
 * - primary_only_failopen_is_full_dual: false (unchanged — coverage classification, not a gate)
 *
 * @param {{
 *   subagentType?: unknown,
 *   gateState?: unknown,
 *   routing?: unknown,
 *   requireDualCheck?: boolean,
 *   toolName?: unknown,
 * }} [input]
 * @returns {{
 *   ok: true,
 *   decision: "allow",
 *   reason: string,
 *   details?: {
 *     dual_status?: string | null,
 *     plan_verdict?: string | null,
 *     isFullDualCoverage?: boolean,
 *     requireDualOn?: string[],
 *   }
 * }}
 */
export function decideDualBeforeDelivery(input = {}) {
  try {
    const {
      subagentType,
      gateState,
      routing,
      requireDualCheck = true,
    } = input;

    // Non-delivery hands: allow without dual check.
    if (!isDeliveryHandRequiringDual(subagentType)) {
      return {
        ok: true,
        decision: "allow",
        reason: "not-a-delivery-hand",
        details: {
          dual_status: readDualStatus(gateState) ?? null,
          isFullDualCoverage: isFullDualCoverage(readDualStatus(gateState)),
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // If dual not required by routing, allow (no ADR-003 posts configured).
    if (!requireDualCheck || !routingRequiresDual(routing)) {
      return {
        ok: true,
        decision: "allow",
        reason: "dual-not-required-by-routing",
        details: {
          dual_status: readDualStatus(gateState) ?? null,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Forged dual_completed boolean / invalid dual fields — record-only (#483): flagged in
    // `reason` for observability, never denied. Bare `dual_completed` is checked explicitly
    // too (in case it slips past validateGateStateDualFields's own rules in the future).
    const shape = validateGateStateDualFields(gateState ?? {});
    const hasBareDualCompleted =
      gateState != null &&
      typeof gateState === "object" &&
      !Array.isArray(gateState) &&
      "dual_completed" in /** @type {object} */ (gateState);
    if (!shape.ok || hasBareDualCompleted) {
      return {
        ok: true,
        decision: "allow",
        reason: !shape.ok
          ? `dual-state-invalid-record-only: ${shape.errors.join("; ")}`
          : "dual-state-invalid-record-only: dual_completed bare boolean present — use dual_status enum only",
        details: {
          dual_status: readDualStatus(gateState) ?? null,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Executor path reads plan_review axis only (adversary dual never unlocks hands).
    const dualStatus = readDualStatus(gateState, "plan_review");

    // Missing dual_status — record-only (#483): no longer blocks executor.
    if (dualStatus === undefined || dualStatus === null || dualStatus === "") {
      return {
        ok: true,
        decision: "allow",
        reason:
          "dual_status.plan_review missing — record-only, no longer blocks executor (#483)",
        details: {
          dual_status: null,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Non-enum dual_status — record-only (#483).
    if (!isDualStatusEnum(dualStatus)) {
      return {
        ok: true,
        decision: "allow",
        reason: `dual_status invalid enum (record-only): ${String(dualStatus)}`,
        details: {
          dual_status: dualStatus,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Pending — record-only (#483): no longer blocks executor.
    if (dualStatus === DUAL_STATUS.PENDING) {
      return {
        ok: true,
        decision: "allow",
        reason:
          "dual_status pending — record-only, no longer blocks executor (#483; discipline is prose+orchestration, see revise-nudge.mjs)",
        details: {
          dual_status: dualStatus,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Recorded dual attempt. plan_verdict is reported for observability but — unlike before
    // #483 — a non-APPROVE (or missing) verdict no longer blocks the executor either.
    if (isRecordedDualAttempt(dualStatus)) {
      const full = isFullDualCoverage(dualStatus);
      const planVerdict = readPlanVerdict(gateState);
      if (planVerdict !== "APPROVE") {
        return {
          ok: true,
          decision: "allow",
          reason:
            (planVerdict === "REVISE"
              ? "plan_verdict REVISE"
              : "plan_verdict missing") +
            " — record-only, no longer blocks executor (#483; discipline is prose+orchestration, see revise-nudge.mjs)",
          details: {
            dual_status: dualStatus,
            plan_verdict: planVerdict ?? null,
            isFullDualCoverage: full,
            requireDualOn: readRequireDualOn(routing),
          },
        };
      }
      return {
        ok: true,
        decision: "allow",
        reason:
          dualStatus === DUAL_STATUS.PRIMARY_ONLY
            ? "primary_only allows continue (primary authoritative; not full dual coverage)"
            : dualStatus === DUAL_STATUS.PRIMARY_ONLY_FAILOPEN
            ? "primary_only_failopen allows continue (not full dual coverage)"
            : dualStatus === DUAL_STATUS.PRIMARY_ONLY_ERROR
              ? "primary_only_error allows continue after retry policy (not full dual coverage)"
              : "dual_status both — full dual coverage",
        details: {
          dual_status: dualStatus,
          plan_verdict: planVerdict,
          isFullDualCoverage: full,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    return {
      ok: true,
      decision: "allow",
      reason: `dual_status not a recorded attempt (record-only): ${dualStatus}`,
      details: {
        dual_status: dualStatus,
        isFullDualCoverage: false,
        requireDualOn: readRequireDualOn(routing),
      },
    };
  } catch (err) {
    // #483 supersedes the #482-era deny-closed rationale that used to live here: with the
    // dual gate off the dispatch surface entirely, an unexpected exception can no longer
    // "silently release a delivery hand with no recorded review coverage" any more than the
    // ordinary allow path already does by design — there is no asymmetry left to protect.
    return {
      ok: true,
      decision: "allow",
      reason:
        err instanceof Error
          ? `dual-classification-error-record-only: ${err.message}`
          : "dual-classification-error-record-only",
    };
  }
}

/**
 * @description Shell helper: classify dual state for logging. Record-only (#483) — never
 * throws, since decideDualBeforeDelivery never returns "deny" anymore. Kept as a thin,
 * stably-named wrapper for dual tests and remaining dual callers until #583.
 * @param {string} prefix - e.g. "[entry-gate]" or "[plan-gate]" (observability only)
 * @param {Parameters<typeof decideDualBeforeDelivery>[0]} input
 * @returns {ReturnType<typeof decideDualBeforeDelivery>}
 */
export function enforceDualOrThrow(prefix, input = {}) {
  return decideDualBeforeDelivery(input);
}

/**
 * @description Extract session id from tool args / env (best-effort). Never throws.
 * @param {unknown} toolArgs
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function extractSessionId(toolArgs, env = process.env) {
  try {
    if (toolArgs != null && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
      const a = /** @type {Record<string, unknown>} */ (toolArgs);
      const nested =
        a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
          ? /** @type {Record<string, unknown>} */ (a.input)
          : null;
      for (const raw of [
        a.session_id,
        a.sessionId,
        nested?.session_id,
        nested?.sessionId,
      ]) {
        if (isSafeSessionIdSegment(raw)) return /** @type {string} */ (raw);
      }
    }
    const envObj = env && typeof env === "object" ? env : {};
    for (const key of [
      "OPENCODE_SESSION_ID",
      "OPENCODE_SESSION",
      "SESSION_ID",
      "HARNESS_SESSION_ID",
    ]) {
      const v = /** @type {Record<string, unknown>} */ (envObj)[key];
      if (isSafeSessionIdSegment(v)) return /** @type {string} */ (v);
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @description Load harness.routing.json from project disk. Never throws.
 * Tries `.opencode/harness.routing.json` then `harness.routing.json`.
 * @param {string} projectRoot
 * @returns {{ ok: true, routing: unknown, path: string } | { ok: false, reason: string }}
 */
export function loadRoutingFromDisk(projectRoot) {
  try {
    const root =
      typeof projectRoot === "string" && projectRoot.length > 0
        ? projectRoot
        : process.cwd();
    if (typeof root !== "string" || root.length === 0) {
      return { ok: false, reason: "projectRoot missing" };
    }
    const candidates = [
      path.join(root, ".opencode", "harness.routing.json"),
      path.join(root, "harness.routing.json"),
    ];
    for (const p of candidates) {
      try {
        const raw = fs.readFileSync(p, "utf8");
        const parsed = JSON.parse(raw);
        const routing = adaptRoutingV1(parsed);
        const validation = validateRouting(routing);
        if (!validation.ok) throw new Error(validation.reason);
        if (parsed?.version === 1 && !warnedLegacyRoutingPaths.has(p)) {
          warnedLegacyRoutingPaths.add(p);
          console.warn(`[harness] routing v1 compatibility adapter used for ${p}; migrate to version 2`);
        }
        return { ok: true, routing, path: p };
      } catch {
        // try next candidate
      }
    }
    return {
      ok: false,
      reason: "harness.routing.json not found or unreadable",
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "loadRoutingFromDisk failed",
    };
  }
}

/**
 * @description Load disk state for a delivery-hand task and classify dual state. Record-only
 * (#483) — never throws. An unreadable gate-state (missing sessionId, corrupt JSON, any
 * other disk-load fault) is shadow-recorded (logged) and treated identically to an absent
 * ceremony: classification proceeds against an empty state instead of failing closed.
 * plan-gate still calls this until #583; entry-gate does not (#580 utils extracted).
 * @param {string} prefix
 * @param {{
 *   projectRoot: string,
 *   toolName?: unknown,
 *   toolArgs?: unknown,
 *   sessionId?: string | null,
 * }} input
 * @returns {ReturnType<typeof decideDualBeforeDelivery>}
 */
export function enforceDualFromDiskOrThrow(prefix, input) {
  const toolName = input.toolName ?? "task";
  if (!isTaskTool(toolName)) {
    return { ok: true, decision: "allow", reason: "not-applicable" };
  }

  const subagentType = extractSubagentType(input.toolArgs);
  const bare = bareSubagentType(subagentType);
  if (bare.length > 0 && !isDeliveryHandRequiringDual(subagentType)) {
    return { ok: true, decision: "allow", reason: "not-a-delivery-hand" };
  }

  const sessionId = Object.hasOwn(input, "sessionId")
    ? input.sessionId
    : extractSessionId(input.toolArgs);
  const loaded = loadGateStateFromDisk(input.projectRoot, {
    sessionId: sessionId ?? undefined,
  });
  let gateState = {};
  let routing = null;
  if (loaded.ok) {
    gateState = loaded.state;
    const routingLoaded = loadRoutingFromDisk(input.projectRoot);
    routing = routingLoaded.ok ? routingLoaded.routing : null;
  } else {
    const p =
      typeof prefix === "string" && prefix.length > 0
        ? prefix
        : "[dual-enforcement]";
    console.warn(`${p} gate-state-unreadable (record-only, dispatch allowed): ${loaded.reason}`);
  }
  return enforceDualOrThrow(prefix, {
    subagentType,
    gateState,
    routing,
    requireDualCheck: true,
    toolName,
  });
}

// Re-export shape helpers so shells have one import surface.
export {
  DUAL_STATUS,
  isFullDualCoverage,
  isRecordedDualAttempt,
  isDualStatusEnum,
  dualStatusGatePatch,
  dualStatusGatePatchForPhase,
  dualStatusPhaseFromRole,
  normalizeDualStatusMap,
  validateGateStateDualFields,
};
