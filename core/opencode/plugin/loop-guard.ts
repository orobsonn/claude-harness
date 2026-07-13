/** @description OC loop-guard plugin — plan-review + adversary counters on disk (warn=2, deny=4). */
import type { Plugin, Hooks } from "@opencode-ai/plugin"

const subagentOf = (args: any): string =>
  args?.subagent_type ?? args?.subagentType ?? args?.agent ?? ""

/**
 * @description Builds loop-guard hooks (async load of pure mjs).
 */
export async function createLoopGuardHooks(
  directory: string,
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after">> {
  const dirSafe =
    typeof directory === "string" && directory.length > 0
      ? directory
      : process.cwd()

  const {
    decideLoopGuard,
    nextLoopCount,
    throwIfLoopDenied,
    loopCounterKey,
  } = await import("./lib/loop-decide.mjs")
  const { withGateStateLock } = await import("./lib/gate-state.mjs")
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { mergeGateStatePatch } = await import("../../shared/lib/gate-state-shape.mjs")

  function statePathFor(sessionID: string): string | null {
    const res = gateStatePath({
      projectRoot: dirSafe,
      runtime: "opencode",
      sessionId: sessionID,
    })
    return res.ok ? res.path : null
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input?.tool !== "task") return
      const sessionID = input?.sessionID ?? ""
      if (!sessionID) return
      const sub = subagentOf(output?.args)
      const key = loopCounterKey(sub)
      if (!key) return

      const sp = statePathFor(sessionID)
      if (!sp) return

      const result = withGateStateLock(sp, (prev) => {
        const step = nextLoopCount(prev, sub)
        if (!step) return prev
        const applied = mergeGateStatePatch(prev, { [step.key]: step.next })
        return applied.ok ? applied.state : prev
      })

      if (!result.ok) {
        throw new Error(`[loop-guard] ${result.reason}`)
      }

      const count =
        typeof result.state[key] === "number" ? (result.state[key] as number) : 0
      const decision = decideLoopGuard({ subagentType: sub, count })
      throwIfLoopDenied(decision)
    },

    "tool.execute.after": async () => {
      // counters incremented in before so deny can fire before dispatch
    },
  }
}

/**
 * @description Resolve project root — never empty string into hooks.
 */
function resolveProjectRoot(directory?: unknown, worktree?: unknown): string {
  if (typeof directory === "string" && directory.length > 0) return directory
  if (typeof worktree === "string" && worktree.length > 0) return worktree
  if (
    directory != null &&
    typeof directory === "object" &&
    !Array.isArray(directory)
  ) {
    const nested = (directory as { directory?: unknown }).directory
    if (typeof nested === "string" && nested.length > 0) return nested
  }
  return process.cwd()
}

export const LoopGuard: Plugin = async ({ directory, worktree }: any) => {
  if (process.env.OC_LOOP_GUARD_OFF === "1") return {}
  return createLoopGuardHooks(resolveProjectRoot(directory, worktree))
}

export default LoopGuard
