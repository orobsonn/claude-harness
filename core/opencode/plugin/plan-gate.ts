/**
 * @description OC plan-gate plugin — full plan required + ADR-003 dual enforcement.
 * Before executor task dispatch: dual_status must be a recorded attempt enum
 * (both | primary_only_failopen | primary_only_error). Deny throws [plan-gate].
 * Reads gate-state and harness.routing.json from disk via input.directory.
 * primary_only_failopen allows continue (OpenAI unavailable) but is not full dual.
 * Fail-closed on unreadable gate-state for delivery hands. No Map-only state.
 */

import {
  decideDualBeforeDelivery,
  enforceDualOrThrow,
  enforceDualFromDiskOrThrow,
  extractSubagentType,
  extractSessionId,
  isTaskTool,
  isDeliveryHandRequiringDual,
  loadGateStateFromDisk,
  loadRoutingFromDisk,
  readRequireDualOn,
  readDualStatus,
  isFullDualCoverage,
} from "./lib/dual-enforcement.mjs";

const PREFIX = "[plan-gate]";

/**
 * @description Pure dual check for plan-gate (testable without OC runtime).
 */
export function decidePlanDual(input: {
  toolName?: unknown;
  toolArgs?: unknown;
  gateState?: unknown;
  routing?: unknown;
}) {
  const { toolName, toolArgs, gateState, routing } = input;
  if (toolName != null && toolName !== "" && !isTaskTool(toolName)) {
    return {
      ok: true,
      decision: "allow" as const,
      reason: "not-task-tool",
    };
  }
  const subagentType = extractSubagentType(toolArgs);
  return decideDualBeforeDelivery({
    subagentType,
    gateState,
    routing,
    requireDualCheck: true,
    toolName: toolName ?? "task",
  });
}

/**
 * @description Throw [plan-gate] when dual_status pending/missing before executor.
 */
export function enforcePlanDualOrThrow(input: {
  toolName?: unknown;
  toolArgs?: unknown;
  gateState?: unknown;
  routing?: unknown;
}) {
  if (input.toolName != null && input.toolName !== "" && !isTaskTool(input.toolName)) {
    return { ok: true, decision: "allow" as const, reason: "not-task-tool" };
  }
  const subagentType = extractSubagentType(input.toolArgs);
  return enforceDualOrThrow(PREFIX, {
    subagentType,
    gateState: input.gateState,
    routing: input.routing,
    requireDualCheck: true,
    toolName: input.toolName ?? "task",
  });
}

/**
 * @description OpenCode plugin factory. Uses input.directory for disk paths.
 * No 3rd-arg deps — OC only passes (input, options).
 * Optional options.readGateState / options.readRouting for unit tests only.
 */
export default async function planGatePlugin(
  input: { directory?: string },
  options?: Record<string, unknown>,
) {
  const directory =
    typeof input?.directory === "string" && input.directory.length > 0
      ? input.directory
      : process.cwd();

  const optReadGate =
    options && typeof options.readGateState === "function"
      ? (options.readGateState as () => unknown)
      : null;
  const optReadRouting =
    options && typeof options.readRouting === "function"
      ? (options.readRouting as () => unknown)
      : null;

  return {
    "tool.execute.before": async (ctx: {
      tool?: string;
      args?: unknown;
    }) => {
      const toolName = ctx?.tool ?? "";
      if (!isTaskTool(toolName)) return;

      if (optReadGate || optReadRouting) {
        const subagentType = extractSubagentType(ctx?.args);
        enforceDualOrThrow(PREFIX, {
          subagentType,
          gateState: optReadGate ? optReadGate() : {},
          routing: optReadRouting ? optReadRouting() : null,
          requireDualCheck: true,
          toolName,
        });
        return;
      }

      // Production path: real disk gate-state + routing under input.directory.
      enforceDualFromDiskOrThrow(PREFIX, {
        projectRoot: directory,
        toolName,
        toolArgs: ctx?.args,
      });
    },
  };
}

export {
  decideDualBeforeDelivery,
  enforceDualOrThrow,
  enforceDualFromDiskOrThrow,
  extractSubagentType,
  extractSessionId,
  isTaskTool,
  isDeliveryHandRequiringDual,
  loadGateStateFromDisk,
  loadRoutingFromDisk,
  readRequireDualOn,
  readDualStatus,
  isFullDualCoverage,
  PREFIX as PLAN_GATE_PREFIX,
};
