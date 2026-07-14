/**
 * @description Deterministic ADR-003 dual enforcement for OC entry-gate / plan-gate.
 * requireDualOn from harness.routing.json; dual_status enum on gate-state.
 * Before executor/delivery hands: dual_status must be a recorded attempt
 * (both | primary_only_failopen | primary_only_error) — never pending/missing.
 * primary_only_failopen allows continue; isFullDualCoverage is false for it.
 * Never invents secondary findings; never leaks secondary verdicts.
 * Pure Decision returns — shells throw. Disk loaders return Result (never throw).
 * Role matching is case-insensitive. Task tool with empty subagent_type fails closed.
 * Production shells load gate-state from .opencode/plans/.state and routing from disk.
 * Fail-closed when gate-state is unreadable for delivery hands.
 * dualStatusGatePatch is the only allowed dual_status writer shape (enum only).
 * No Map-only state.
 */

import fs from "node:fs";
import path from "node:path";
import {
  DUAL_STATUS,
  isFullDualCoverage,
  isRecordedDualAttempt,
  isDualStatusEnum,
  dualStatusGatePatch,
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
 * @description Extract dual_status from gate-state. Never throws.
 * @param {unknown} gateState
 * @returns {string | undefined}
 */
export function readDualStatus(gateState) {
  try {
    if (
      gateState == null ||
      typeof gateState !== "object" ||
      Array.isArray(gateState)
    ) {
      return undefined;
    }
    const v = /** @type {Record<string, unknown>} */ (gateState).dual_status;
    return typeof v === "string" ? v : undefined;
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

    const dualStatus = readDualStatus(gateState);

    // Missing dual_status → deny (pending_blocks_executor / dual_status_required_before_executor).
    if (dualStatus === undefined || dualStatus === null || dualStatus === "") {
      return {
        ok: false,
        decision: "deny",
        reason:
          "dual_status missing — requireDualOn post must record a dual attempt before executor (both | primary_only_failopen | primary_only_error)",
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
          "dual_status pending — dual attempt not yet recorded; block executor until both | primary_only_failopen | primary_only_error",
        details: {
          dual_status: dualStatus,
          isFullDualCoverage: false,
          requireDualOn: readRequireDualOn(routing),
        },
      };
    }

    // Recorded attempts: both | primary_only_failopen | primary_only_error → allow.
    if (isRecordedDualAttempt(dualStatus)) {
      const full = isFullDualCoverage(dualStatus);
      return {
        ok: true,
        decision: "allow",
        reason:
          dualStatus === DUAL_STATUS.PRIMARY_ONLY_FAILOPEN
            ? "primary_only_failopen allows continue (not full dual coverage)"
            : dualStatus === DUAL_STATUS.PRIMARY_ONLY_ERROR
              ? "primary_only_error allows continue after retry policy (not full dual coverage)"
              : "dual_status both — full dual coverage",
        details: {
          dual_status: dualStatus,
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
 * Checks flat keys, nested input, subagent, and command. Never throws.
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
      a.command,
      nested?.subagent_type,
      nested?.subagentType,
      nested?.agent,
      nested?.agent_type,
      nested?.subagent,
      nested?.command,
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
 * @description Whether tool name is the OC task dispatch tool.
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isTaskTool(toolName) {
  if (typeof toolName !== "string") return false;
  const n = toolName.toLowerCase();
  return n === "task" || n.endsWith("_task") || n.endsWith(".task");
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
  validateGateStateDualFields,
};
