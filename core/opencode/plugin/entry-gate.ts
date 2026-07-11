/** @description OC entry-gate plugin — ceremony + fidelity rail (test-author exempt). State on disk. */
import type { Plugin, Hooks } from "@opencode-ai/plugin"

const subagentOf = (args: any): string =>
  args?.subagent_type ?? args?.subagentType ?? args?.agent ?? ""

const skillNameOf = (args: any): string => {
  if (args && typeof args === "object") {
    const n = args.name ?? args.skill ?? args.skillName
    if (typeof n === "string") return n
  }
  return ""
}

/**
 * @description Builds entry-gate hooks bound to project directory (async load of pure mjs).
 */
export async function createEntryGateHooks(
  directory: string,
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after">> {
  const dirSafe = typeof directory === "string" ? directory : ""

  const { decideEntryTask, throwIfDenied } = await import("./lib/entry-decide.mjs")
  const { mergeGateState, readGateState } = await import("./lib/gate-state.mjs")
  const { isAdversaryRole, isDeliveryRole } = await import("./lib/roles.mjs")
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")

  function statePathFor(sessionID: string): string | null {
    const res = gateStatePath({
      projectRoot: dirSafe,
      runtime: "opencode",
      sessionId: sessionID,
    })
    return res.ok ? res.path : null
  }

  return {
    "tool.execute.after": async (input, output) => {
      const tool = input?.tool
      const sessionID = input?.sessionID ?? ""
      if (!sessionID) return

      if (tool === "classify") {
        const meta = (output as any)?.metadata
        if (meta && typeof meta.plan_path === "string" && !meta.error) {
          const sp = statePathFor(sessionID)
          if (sp) {
            mergeGateState(sp, {
              session_id: sessionID,
              classified: true,
              triaged: true,
              mode: typeof meta.mode === "string" ? meta.mode : undefined,
              feature_id: typeof meta.feature_id === "string" ? meta.feature_id : undefined,
            })
          }
        }
      }
    },

    "tool.execute.before": async (input, output) => {
      const tool = input?.tool
      const sessionID = input?.sessionID ?? ""
      const args = output?.args
      if (!sessionID) return

      if (tool === "skill") {
        const name = skillNameOf(args)
        const sp = statePathFor(sessionID)
        if (!sp) return
        if (name.includes("triaging-requests")) {
          mergeGateState(sp, { triaged: true, session_id: sessionID })
        }
        if (name.includes("brainstorming")) {
          mergeGateState(sp, { brainstormed: true, session_id: sessionID })
        }
        return
      }

      if (tool !== "task") return

      const subagent = subagentOf(args)
      if (!isDeliveryRole(subagent)) return

      const sp = statePathFor(sessionID)
      const gateState = sp ? readGateState(sp) : {}

      const decision = decideEntryTask({
        subagentType: subagent,
        gateState,
        mode: gateState.mode,
        featureId: gateState.feature_id,
        taskId: args?.task_id ?? args?.taskId,
      })
      throwIfDenied(decision)

      // ADV-ADVERSARY-STAMP-BYPASS: stamp only after successful allow — never before decide.
      if (isAdversaryRole(subagent) && sp && decision?.decision === "allow") {
        mergeGateState(sp, { adversary_fired: true, session_id: sessionID })
      }
    },
  }
}

export const EntryGate: Plugin = async ({ directory, worktree }: any) => {
  if (process.env.OC_ENTRY_GATE_OFF === "1") return {}
  const dir: string =
    typeof directory === "string"
      ? directory
      : typeof worktree === "string"
        ? worktree
        : String(
            (directory as any)?.directory ??
              (directory as any)?.worktree ??
              (worktree as any)?.directory ??
              "",
          )
  return createEntryGateHooks(dir)
}

export default EntryGate
