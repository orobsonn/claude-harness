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
  const dirSafe = typeof directory === "string" ? directory : ""

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

export const LoopGuard: Plugin = async ({ directory, worktree }: any) => {
  if (process.env.OC_LOOP_GUARD_OFF === "1") return {}
  const dir: string =
    typeof directory === "string"
      ? directory
      : typeof worktree === "string"
        ? worktree
        : String((directory as any)?.directory ?? "")
  return createLoopGuardHooks(dir)
}

export default LoopGuard
