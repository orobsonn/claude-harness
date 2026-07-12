/**
 * @description OC entry-gate plugin — deterministic ceremony + ADR-003 dual enforcement.
 * On tool.execute.before for task delivery hands (executor/sniper), requires
 * dual_status recorded attempt when requireDualOn is configured.
 * Deny throws [entry-gate]. Fail-closed on unreadable gate-state for delivery hands.
 * Load shape matches loop-guard: dynamic import of pure mjs inside Plugin factory
 * (static import of dual-enforcement.mjs breaks OC plugin loader — "export is not a function").
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"

const PREFIX = "[entry-gate]"

/**
 * @description Builds entry-gate hooks (async load of pure dual-enforcement mjs).
 */
export async function createEntryGateHooks(
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
export const EntryGate: Plugin = async ({ directory, worktree }: any) => {
  const dir: string =
    typeof directory === "string" && directory.length > 0
      ? directory
      : typeof worktree === "string" && worktree.length > 0
        ? worktree
        : String((directory as any)?.directory ?? process.cwd())
  return createEntryGateHooks(dir)
}

export default EntryGate
