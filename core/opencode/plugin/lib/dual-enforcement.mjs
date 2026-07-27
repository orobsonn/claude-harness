/**
 * @description Deterministic ADR-003 dual enforcement for OC entry-gate / plan-gate.
 * requireDualOn from harness.routing.json; dual_status enum on gate-state.
 * dual_status is per-phase ({ plan_review, adversary } map, or legacy scalar =
 * plan_review only). Before executor/delivery hands: plan_review dual must be a
 * recorded attempt (both | primary_only | legacy primary_only_failopen/error) —
 * never pending/missing — AND plan_verdict must be APPROVE (REVISE/missing
 * fail-closed; dual alone never unlocks). Adversary dual does not unlock executor.
 * primary_only_failopen allows continue; isFullDualCoverage is false for it.
 * Never invents secondary findings; never leaks secondary verdicts.
 * Pure Decision returns — shells throw. Disk loaders return Result (never throw).
 * Role matching is case-insensitive. Task tool with empty subagent_type fails closed.
 * Production shells load gate-state from .opencode/plans/.state and routing from disk.
 * Fail-closed when gate-state is unreadable for delivery hands.
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

/** Session id safe for path segment (no traversal). Aligned with OC session ids (ses_…). */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

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
 * @description True when session id is safe as a single path segment.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeSessionIdSegment(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return false;
  }
  // Reject path traversal and separators before regex.
  if (value.includes("..") || value.includes("/") || value.includes("\\")) {
    return false;
  }
  return SAFE_SESSION_ID.test(value);
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
      return [...DEFAULT_REQUIRE_DUAL_ON];
    }
    const constraints =
      /** @type {Record<string, unknown>} */ (routing).constraints;
    if (
      constraints == null ||
      typeof constraints !== "object" ||
      Array.isArray(constraints)
    ) {
      return [...DEFAULT_REQUIRE_DUAL_ON];
    }
    const list =
      /** @type {Record<string, unknown>} */ (constraints).requireDualOn;
    if (!Array.isArray(list) || list.length === 0) {
      return [...DEFAULT_REQUIRE_DUAL_ON];
    }
    return list.filter((r) => typeof r === "string" && r.length > 0);
  } catch {
    return [...DEFAULT_REQUIRE_DUAL_ON];
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
 * @description Decide whether a delivery hand may proceed given dual_status.
 * Pure Decision — never throws.
 *
 * Rules (resolved_judgments):
 * - dual_status_required_before_executor: true
 * - pending_blocks_executor: true
 * - primary_only_failopen_allows_continue: true
 * - primary_only_failopen_is_full_dual: false
 * - bare_boolean_dual_completed_rejected: true
 *
 * @param {{
 *   subagentType?: unknown,
 *   gateState?: unknown,
 *   routing?: unknown,
 *   requireDualCheck?: boolean,
 *   toolName?: unknown,
 * }} [input]
 * @returns {{
 *   ok: boolean,
 *   decision: "allow" | "deny" | "warn",
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
      toolName,
    } = input;

    const bare = bareSubagentType(subagentType);

    // Task tool with empty/unknown agent after parse → fail-closed
    // (cannot skip dual by omitting subagent_type).
    if (
      requireDualCheck &&
      toolName != null &&
      isTaskTool(toolName) &&
      bare.length === 0
    ) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "dual_status-required-unknown-agent — task tool missing subagent_type; fail-closed",
        details: {
          dual_status: readDualStatus(gateState) ?? null,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

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

    // Reject forged dual_completed boolean / invalid dual fields.
    const shape = validateGateStateDualFields(gateState ?? {});
    if (!shape.ok) {
      return {
        ok: false,
        decision: "deny",
        reason: `dual-state-invalid: ${shape.errors.join("; ")}`,
        details: {
          dual_status: readDualStatus(gateState) ?? null,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Also reject dual_completed even if dual_status is valid (forged path).
    if (
      gateState != null &&
      typeof gateState === "object" &&
      !Array.isArray(gateState) &&
      "dual_completed" in /** @type {object} */ (gateState)
    ) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "dual-state-invalid: dual_completed bare boolean rejected — use dual_status enum only",
        details: {
          dual_status: readDualStatus(gateState) ?? null,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Executor path reads plan_review axis only (adversary dual never unlocks hands).
    const dualStatus = readDualStatus(gateState, "plan_review");

    // Missing dual_status → deny (pending_blocks_executor / dual_status_required_before_executor).
    if (dualStatus === undefined || dualStatus === null || dualStatus === "") {
      return {
        ok: false,
        decision: "deny",
        reason:
            "dual_status.plan_review missing — requireDualOn plan-review post must record a primary result before executor (both | primary_only)",
        details: {
          dual_status: null,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Non-enum dual_status → deny.
    if (!isDualStatusEnum(dualStatus)) {
      return {
        ok: false,
        decision: "deny",
        reason: `dual_status invalid enum: ${String(dualStatus)}`,
        details: {
          dual_status: dualStatus,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // pending blocks executor.
    if (dualStatus === DUAL_STATUS.PENDING) {
      return {
        ok: false,
        decision: "deny",
        reason:
          "dual_status pending — primary result not yet recorded; block executor until both | primary_only",
        details: {
          dual_status: dualStatus,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Recorded dual is necessary but not sufficient: plan-review must APPROVE.
    // dual_status both + REVISE (or missing plan_verdict) must not unlock executors.
    if (isRecordedDualAttempt(dualStatus)) {
      const full = isFullDualCoverage(dualStatus);
      const planVerdict = readPlanVerdict(gateState);
      if (planVerdict !== "APPROVE") {
        return {
          ok: false,
          decision: "deny",
          reason:
            planVerdict === "REVISE"
              ? "plan_verdict REVISE — executor blocked until plan-review APPROVE"
              : "plan_verdict missing — executor requires plan-review APPROVE (not only dual_status)",
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
      ok: false,
      decision: "deny",
      reason: `dual_status not a recorded attempt: ${dualStatus}`,
      details: {
        dual_status: dualStatus,
        isFullDualCoverage: false,
        requireDualOn: readRequireDualOn(routing),
      },
    };
  } catch (err) {
    // Pure path: on unexpected error, deny closed for delivery hands (safe).
    // #482 deliberately does NOT extend the fail-open drive-by here (unlike entry-decide.mjs's
    // generic ceremony catch-all): this function is the ADR-003 dual-review-coverage authority,
    // its input is gate-state.json — writable by hands via bash before this decision runs — and
    // an adversarial review found that an unexpected exception here would silently release a
    // delivery hand with NO recorded review coverage at all, a materially stronger invariant than
    // the "has ceremony started" check entry-decide.mjs guards. Deny-closed on an internal fault.
    return {
      ok: false,
      decision: "deny",
      reason:
        err instanceof Error
          ? `dual-enforcement-error: ${err.message}`
          : "dual-enforcement-error",
    };
  }
}

/**
 * @description Shell helper: throw with stable prefix when dual decision is deny.
 * Used by entry-gate / plan-gate OC plugins.
 * @param {string} prefix - e.g. "[entry-gate]" or "[plan-gate]"
 * @param {Parameters<typeof decideDualBeforeDelivery>[0]} input
 * @returns {ReturnType<typeof decideDualBeforeDelivery>}
 */
export function enforceDualOrThrow(prefix, input = {}) {
  const decision = decideDualBeforeDelivery(input);
  if (decision.decision === "deny") {
    const p =
      typeof prefix === "string" && prefix.length > 0
        ? prefix
        : "[dual-enforcement]";
    throw new Error(`${p} ${decision.reason}`);
  }
  return decision;
}

/**
 * @description Extract subagent_type from OC task tool args (best-effort).
 * Role sources only: subagent_type / agent* aliases (flat + nested input).
 * Never reads official Task `command` or `task_id` — those are host resume fields.
 * Never throws.
 * @param {unknown} toolArgs
 * @returns {string}
 */
export function extractSubagentType(toolArgs) {
  try {
    if (
      toolArgs == null ||
      typeof toolArgs !== "object" ||
      Array.isArray(toolArgs)
    ) {
      return "";
    }
    const a = /** @type {Record<string, unknown>} */ (toolArgs);
    const nested =
      a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
        ? /** @type {Record<string, unknown>} */ (a.input)
        : null;
    const candidates = [
      a.subagent_type,
      a.subagentType,
      a.agent,
      a.agent_type,
      a.subagent,
      nested?.subagent_type,
      nested?.subagentType,
      nested?.agent,
      nested?.agent_type,
      nested?.subagent,
    ];
    for (const raw of candidates) {
      if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
    }
    return "";
  } catch {
    return "";
  }
}

/**
 * @description Whether tool name is the OC Task/agent dispatch family.
 * Canonical rule (shared with loop-guard, obs-hand, obs-eye): task | agent |
 * endsWith .task | .agent (case-insensitive).
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isTaskTool(toolName) {
  if (typeof toolName !== "string") return false;
  const n = toolName.toLowerCase();
  return (
    n === "task" ||
    n === "agent" ||
    n.endsWith(".task") ||
    n.endsWith(".agent")
  );
}

/**
 * @description Extract task context from OC hook (input, output) shape for entry/plan gates.
 * tool from input?.tool; args from output?.args (NOT input.args as primary);
 * sessionID from input?.sessionID; subagentType via extractSubagentType(args).
 * If args only on first arg and second empty → subagentType empty (documents wrong shape).
 * @param {unknown} input
 * @param {unknown} output
 * @returns {{ toolName: string, toolArgs: unknown, sessionId: string | null, subagentType: string }}
 */
export function extractHookTaskContext(input, output) {
  const toolName = input?.tool ?? "";
  // Belt: OC may put task args on output.args (primary) or input.args.
  const toolArgs = output?.args ?? input?.args ?? null;
  const sessionId = input?.sessionID ?? input?.sessionId ?? null;
  const subagentType = extractSubagentType(toolArgs);
  return { toolName, toolArgs, sessionId, subagentType };
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
 * @description Load gate-state.json from disk under `.opencode/plans/.state/`.
 * Requires explicit safe sessionId; explicit fail when missing (no cross-session mtime).
 * Fail-closed Result when unreadable. Never throws.
 * @param {string} projectRoot
 * @param {{ sessionId?: string | null }} [opts]
 * @returns {{ ok: true, state: unknown, path: string } | { ok: false, reason: string }}
 */
export function loadGateStateFromDisk(projectRoot, opts = {}) {
  try {
    const root =
      typeof projectRoot === "string" && projectRoot.length > 0
        ? projectRoot
        : process.cwd();
    if (typeof root !== "string" || root.length === 0) {
      return { ok: false, reason: "projectRoot missing" };
    }
    const stateRoot = path.join(root, ".opencode", "plans", ".state");
    const sessionId = opts.sessionId;

    /** @param {string} p */
    function readStateFile(p) {
      try {
        if (!fs.existsSync(p)) {
          // Missing file = empty ceremony (not yet classified), not infra failure.
          // Fail-closed on dual/plan still applies via empty dual_status / missing plan.
          return { ok: true, state: {}, path: p };
        }
        const raw = fs.readFileSync(p, "utf8");
        const state = JSON.parse(raw);
        if (state == null || typeof state !== "object" || Array.isArray(state)) {
          return {
            ok: false,
            reason: `gate-state invalid JSON object at ${p}`,
          };
        }
        return { ok: true, state, path: p };
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error
              ? `gate-state-unreadable: ${err.message}`
              : "gate-state-unreadable",
        };
      }
    }

    if (sessionId != null && sessionId !== "") {
      if (!isSafeSessionIdSegment(sessionId)) {
        return { ok: false, reason: "unsafe sessionId" };
      }
      const p = path.join(
        stateRoot,
        /** @type {string} */ (sessionId),
        "gate-state.json",
      );
      return readStateFile(p);
    }
    return { ok: false, reason: "sessionId required for deterministic gate-state load" };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "loadGateStateFromDisk failed",
    };
  }
}

/**
 * @description Load disk state for a delivery-hand task and enforce dual, or throw.
 * Fail-closed when gate-state is unreadable. Used by entry-gate / plan-gate shells.
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
  // Empty agent on task → still enforce (fail-closed via decideDualBeforeDelivery).
  // Non-delivery named agents skip dual.
  if (bare.length > 0 && !isDeliveryHandRequiringDual(subagentType)) {
    return { ok: true, decision: "allow", reason: "not-a-delivery-hand" };
  }

  const sessionId = Object.hasOwn(input, "sessionId")
    ? input.sessionId
    : extractSessionId(input.toolArgs);
  const loaded = loadGateStateFromDisk(input.projectRoot, {
    sessionId: sessionId ?? undefined,
  });
  if (!loaded.ok) {
    const p =
      typeof prefix === "string" && prefix.length > 0
        ? prefix
        : "[dual-enforcement]";
    throw new Error(`${p} gate-state-unreadable: ${loaded.reason}`);
  }
  const routingLoaded = loadRoutingFromDisk(input.projectRoot);
  return enforceDualOrThrow(prefix, {
    subagentType,
    gateState: loaded.state,
    routing: routingLoaded.ok ? routingLoaded.routing : null,
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
