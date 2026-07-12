/**
 * @description OC plan-gate plugin — full plan required + ADR-003 dual enforcement.
 * Before executor task dispatch: dual_status must be a recorded attempt.
 * Deny throws [plan-gate]. Fail-closed on unreadable gate-state for delivery hands.
 * Load shape matches loop-guard: dynamic import of pure mjs inside Plugin factory
 * (static import of dual-enforcement.mjs breaks OC plugin loader — "export is not a function").
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"

const PREFIX = "[plan-gate]"

/**
 * @description Builds plan-gate hooks (async load of pure dual-enforcement mjs).
 */
export async function createPlanGateHooks(
  projectRoot: string,
): Promise<Pick<Hooks, "tool.execute.before">> {
  const {
    enforceDualFromDiskOrThrow,
    extractHookTaskContext,
    isTaskTool,
  } = await import("./lib/dual-enforcement.mjs")

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const { toolName, toolArgs, sessionId } = extractHookTaskContext(input, output)
      if (!isTaskTool(toolName)) return
      enforceDualFromDiskOrThrow(PREFIX, {
        projectRoot,
        toolName,
        toolArgs,
        sessionId: sessionId ?? undefined,
      })
    },
  }
}

/**
 * @description OpenCode plugin factory — named const + default (OC load contract).
 */
export const PlanGate: Plugin = async ({ directory, worktree }: any) => {
  const dir: string =
    typeof directory === "string" && directory.length > 0
      ? directory
      : typeof worktree === "string" && worktree.length > 0
        ? worktree
        : String((directory as any)?.directory ?? process.cwd())
  return createPlanGateHooks(dir)
}

export default PlanGate
