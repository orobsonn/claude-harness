/**
 * @description OC entry-gate plugin — ceremony + bash delivery/forge + ADR-003 dual.
 * On tool.execute.before:
 * - bash/shell: decideBashForge then decideBashDelivery (gate-state from disk)
 * - task: decideEntryTask then enforceDualFromDiskOrThrow for executor/sniper
 * Deny throws [entry-gate]. Fail-closed on unreadable gate-state for delivery.
 * Load shape matches loop-guard: dynamic import of pure mjs inside factory
 * (static import of mjs breaks OC plugin loader — "export is not a function").
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"

const PREFIX = "[entry-gate]"

/**
 * @description Whether tool name is bash or shell (OC variants).
 */
function isBashOrShellTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false
  const n = toolName.toLowerCase()
  return (
    n === "bash" ||
    n === "shell" ||
    n.endsWith("_bash") ||
    n.endsWith(".bash") ||
    n.endsWith("_shell") ||
    n.endsWith(".shell")
  )
}

/**
 * @description Extract command string from OC bash tool args.
 */
function extractBashCommand(toolArgs: unknown): unknown {
  if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    return undefined
  }
  const a = toolArgs as Record<string, unknown>
  return a.command ?? a.cmd
}

/**
 * @description Best-effort feature/task ids from task tool args.
 */
function extractFeatureTaskIds(toolArgs: unknown): {
  featureId?: string
  taskId?: string
} {
  if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    return {}
  }
  const a = toolArgs as Record<string, unknown>
  const nested =
    a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
      ? (a.input as Record<string, unknown>)
      : null
  const featureRaw =
    a.feature_id ?? a.featureId ?? a.feature ?? nested?.feature_id ?? nested?.featureId
  const taskRaw = a.task_id ?? a.taskId ?? a.task ?? nested?.task_id ?? nested?.taskId
  return {
    featureId: typeof featureRaw === "string" ? featureRaw : undefined,
    taskId: typeof taskRaw === "string" ? taskRaw : undefined,
  }
}

/**
 * @description Builds entry-gate hooks (async load of pure decide mjs).
 */
export async function createEntryGateHooks(
  projectRoot: string,
): Promise<Pick<Hooks, "tool.execute.before">> {
  const {
    enforceDualFromDiskOrThrow,
    extractHookTaskContext,
    isTaskTool,
    loadGateStateFromDisk,
  } = await import("./lib/dual-enforcement.mjs")
  const {
    decideBashForge,
    decideBashDelivery,
    throwIfDenied: throwIfBashDenied,
  } = await import("./lib/bash-decide.mjs")
  const {
    decideEntryTask,
    throwIfDenied: throwIfEntryDenied,
  } = await import("./lib/entry-decide.mjs")

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const { toolName, toolArgs, sessionId, subagentType } =
        extractHookTaskContext(input, output)

      if (isBashOrShellTool(toolName)) {
        const command = extractBashCommand(toolArgs)
        throwIfBashDenied(decideBashForge({ command }))

        const sid =
          typeof sessionId === "string" && sessionId.length > 0
            ? sessionId
            : undefined
        const loaded = loadGateStateFromDisk(projectRoot, { sessionId: sid })
        throwIfBashDenied(
          decideBashDelivery({
            command,
            gateState: loaded.ok ? loaded.state : {},
            sessionId: sid ?? null,
            gateStateLoadOk: loaded.ok,
          }),
        )
        return
      }

      if (!isTaskTool(toolName)) return

      const sid =
        typeof sessionId === "string" && sessionId.length > 0
          ? sessionId
          : undefined
      const loaded = loadGateStateFromDisk(projectRoot, { sessionId: sid })
      const gateState = loaded.ok ? loaded.state : {}
      const { featureId, taskId } = extractFeatureTaskIds(toolArgs)

      throwIfEntryDenied(
        decideEntryTask({
          subagentType,
          gateState,
          featureId,
          taskId,
        }),
      )

      enforceDualFromDiskOrThrow(PREFIX, {
        projectRoot,
        toolName,
        toolArgs,
        sessionId: sid,
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
