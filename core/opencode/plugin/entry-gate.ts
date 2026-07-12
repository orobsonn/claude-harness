/**
 * @description OC entry-gate plugin — ceremony + bash delivery/forge + ADR-003 dual.
 * On tool.execute.before:
 * - bash/shell: decideBashForge then decideBashDelivery (gate-state from disk)
 * - task: decideEntryTask then enforceDualFromDiskOrThrow for executor/sniper
 * Deny throws [entry-gate]. Fail-closed on unreadable gate-state for delivery.
 * Delivery bash injects gitState + isAncestorFn + listHandRecordsForFeatureFn;
 * non-delivery never probes git/list/ancestor.
 * Load shape matches loop-guard: dynamic import of pure mjs inside factory
 * (static import of mjs breaks OC plugin loader — "export is not a function").
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"

const PREFIX = "[entry-gate]"

/**
 * @description Optional injectable seams for tests (git/list/ancestor).
 */
export type EntryGateDeps = {
  gitStateFn?: () => {
    branch?: string | null
    commitsAhead?: number | null
    defaultBranch?: string | null
  } | null
  isAncestorFn?: (sha: string) => boolean | null
  listHandRecordsForFeatureFn?: (featureId: string) => unknown[]
}

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
 * @description Real git runner for computeGitState (trim stdout).
 */
function realGitRunner(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
}

/**
 * @description Fail-open git state probe — null on any error.
 */
function defaultGitState(
  computeGitState: (git: (args: string[]) => string) => {
    branch: string | null
    commitsAhead: number | null
    defaultBranch: string | null
  },
): {
  branch: string | null
  commitsAhead: number | null
  defaultBranch: string | null
} | null {
  try {
    return computeGitState(realGitRunner)
  } catch {
    return null
  }
}

/**
 * @description git merge-base --is-ancestor sha HEAD → true / false / null.
 */
function defaultIsAncestor(sha: string): boolean | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: unknown }).status
        : undefined
    if (status === 1) return false
    return null
  }
}

/**
 * @description Builds entry-gate hooks (async load of pure decide mjs).
 * Optional deps override git/list/ancestor seams for tests.
 */
export async function createEntryGateHooks(
  projectRoot: string,
  deps: EntryGateDeps = {},
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
    isDeliveryCommand,
    throwIfDenied: throwIfBashDenied,
  } = await import("./lib/bash-decide.mjs")
  const {
    decideEntryTask,
    throwIfDenied: throwIfEntryDenied,
  } = await import("./lib/entry-decide.mjs")
  const { computeGitState } = await import("../../shared/lib/git-state.mjs")
  const { listHandRecordsForFeature } = await import("./lib/hand-records.mjs")

  const gitStateFn =
    deps.gitStateFn ?? (() => defaultGitState(computeGitState))
  const isAncestorFn = deps.isAncestorFn ?? defaultIsAncestor
  const listHandRecordsForFeatureFn =
    deps.listHandRecordsForFeatureFn ??
    ((featureId: string) => listHandRecordsForFeature(projectRoot, featureId))

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
        const gateState = loaded.ok ? loaded.state : {}

        /** Delivery-only rails: never probe git/list/ancestor for non-delivery bash. */
        const deliveryExtras: {
          gitState?: ReturnType<typeof gitStateFn>
          isAncestorFn?: typeof isAncestorFn
          listHandRecordsForFeatureFn?: typeof listHandRecordsForFeatureFn
        } = {}
        if (isDeliveryCommand(command)) {
          deliveryExtras.gitState = gitStateFn()
          deliveryExtras.isAncestorFn = isAncestorFn
          deliveryExtras.listHandRecordsForFeatureFn =
            listHandRecordsForFeatureFn
        }

        throwIfBashDenied(
          decideBashDelivery({
            command,
            gateState,
            sessionId: sid ?? null,
            gateStateLoadOk: loaded.ok,
            ...deliveryExtras,
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
