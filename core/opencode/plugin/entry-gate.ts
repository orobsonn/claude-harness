/**
 * @description OC entry-gate plugin — deterministic ceremony + ADR-003 dual enforcement.
 * On tool.execute.before for task delivery hands (executor*/sniper*), requires
 * dual_status recorded attempt when requireDualOn is configured.
 * Reads gate-state and harness.routing.json from disk via input.directory.
 * Deny: throw Error with stable [entry-gate] prefix. No Map-only state.
 * Fail-closed on unreadable gate-state for delivery hands.
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
} from "./lib/dual-enforcement.mjs";

const PREFIX = "[entry-gate]";

/**
 * @description Pure dual check for entry-gate (testable without OC runtime).
 */
export function decideEntryDual(input: {
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
 * @description Throw [entry-gate] when dual_status pending/missing before executor.
 */
export function enforceEntryDualOrThrow(input: {
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
export default async function entryGatePlugin(
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

      // Test injectors via options bag only (not a non-standard 3rd plugin arg).
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
  PREFIX as ENTRY_GATE_PREFIX,
};
