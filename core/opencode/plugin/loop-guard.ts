/** @description OC loop guard: useful family-1 reports count only after execution. */
import type { Plugin, Hooks } from "@opencode-ai/plugin"

/**
 * @description Builds loop-guard hooks (async load of pure mjs).
 */
export async function createLoopGuardHooks(
  directory: string,
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after" | "event">> {
  const dirSafe =
    typeof directory === "string" && directory.length > 0
      ? directory
      : process.cwd()

  const {
    decideLoopGuard,
    applyReviewOutcome,
    classifyReviewBoundaryError,
    reserveReviewAttempt,
    throwIfLoopDenied,
    loopCounterKey,
  } = await import("./lib/loop-decide.mjs")
  const { withGateStateLock } = await import("./lib/gate-state.mjs")
  const { reviewAgentIdentity } = await import("../agents/review-catalog.mjs")
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  // Host dual-merge path (#384): finalizeHostDualMerge → driveDualEye (dual-runtime) — not skill-only.
  const {
    dualMergeIntentFromOutcome,
    finalizeHostDualMerge,
  } = await import("./lib/dual-merge.mjs")
  const { extractSubagentType, isTaskTool } = await import("./lib/dual-enforcement.mjs")

  function argsOf(input: any, output: any): Record<string, unknown> {
    const value = output?.args ?? input?.args ?? input?.toolArgs ?? input?.tool_input ?? {}
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  }

  function featureOf(args: Record<string, unknown>): string {
    const nested = args.input && typeof args.input === "object" && !Array.isArray(args.input)
      ? args.input as Record<string, unknown>
      : {}
    const value = args.feature_id ?? args.featureId ?? nested.feature_id ?? nested.featureId
    return typeof value === "string" ? value : ""
  }

  function stringArg(args: Record<string, unknown>, snake: string, camel: string): string {
    const nested = args.input && typeof args.input === "object" && !Array.isArray(args.input)
      ? args.input as Record<string, unknown>
      : {}
    const value = args[snake] ?? args[camel] ?? nested[snake] ?? nested[camel]
    return typeof value === "string" ? value : ""
  }

  function responseOf(input: any, output: any): unknown {
    return output?.output ?? output?.content ?? output?.result ?? output?.tool_output ?? input?.tool_response ?? ""
  }

  function persistOutcome(input: any, output: any, failureClass?: string) {
    const sessionID = input?.sessionID ?? input?.sessionId ?? ""
    const callID = input?.callID ?? input?.callId ?? ""
    const args = argsOf(input, output)
    const sub = extractSubagentType(args)
    if (!sessionID || !callID) return
    const sp = statePathFor(sessionID)
    if (!sp) return
    /** @type {ReturnType<typeof dualMergeIntentFromOutcome>} */
    let mergeIntent: ReturnType<typeof dualMergeIntentFromOutcome> = null
    const result = withGateStateLock(sp, (prev) => {
      const outcome = applyReviewOutcome(prev, {
        subagentType: sub,
        sessionId: sessionID,
        featureId: featureOf(args),
        taskId: stringArg(args, "task_id", "taskId"),
        phase: stringArg(args, "phase", "phase"),
        callId: callID,
        response: responseOf(input, output),
        failureClass,
      })
      if (outcome.dualBecameBoth === true) {
        mergeIntent = dualMergeIntentFromOutcome(outcome)
      }
      return outcome.state
    })
    if (!result.ok) throw new Error(`[loop-guard] ${result.reason}`)
    // Fail-open: merge artifact is audit trail; gate dual_status / plan_verdict already sealed.
    if (mergeIntent) {
      try {
        finalizeHostDualMerge({
          projectRoot: dirSafe,
          sessionId: sessionID,
          ...mergeIntent,
        })
      } catch {
        /* never block review accounting on merge write */
      }
    }
  }

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
      if (!isTaskTool(input?.tool)) return
      const sessionID = input?.sessionID ?? ""
      if (!sessionID) return
      const args = argsOf(input, output)
      const sub = extractSubagentType(args)
      const identity = reviewAgentIdentity(sub)
      if (!identity) return
      const key = loopCounterKey(sub)

      const sp = statePathFor(sessionID)
      if (!sp) return

      const reserved = withGateStateLock(sp, (state) => {
        const transition = reserveReviewAttempt(state, {
          subagentType: sub,
          sessionId: sessionID,
          featureId: featureOf(args),
          taskId: stringArg(args, "task_id", "taskId"),
          phase: stringArg(args, "phase", "phase"),
          callId: input?.callID ?? input?.callId ?? "",
          projectRoot: dirSafe,
        })
        return transition.ok ? transition.state : { ok: false, reason: transition.reason }
      })
      if (!reserved.ok) throw new Error(`[loop-guard] ${reserved.reason}`)

      if (key) {
        const count = typeof reserved.state[key] === "number" ? reserved.state[key] as number : 0
        const decision = decideLoopGuard({ subagentType: sub, count })
        if (decision.decision === "deny") {
        // reserveReviewAttempt is the slot authority; count-only deny applies only when no slot was reserved.
          const callID = input?.callID ?? input?.callId ?? ""
          const hasReservation = Array.isArray(reserved.state.review_inflight) && reserved.state.review_inflight.some((item: any) => item?.call_id === callID)
          if (!hasReservation) throwIfLoopDenied(decision)
        }
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!isTaskTool(input?.tool)) return
      persistOutcome(input, output)
    },

    event: async ({ event }: any) => {
      if (event?.type !== "message.part.updated") return
      const part = event?.properties?.part
      if (!part || part.type !== "tool" || !isTaskTool(part.tool) || part.state?.status !== "error") return
      persistOutcome(
        { tool: part.tool, sessionID: part.sessionID, callID: part.callID, args: part.state?.input },
        { args: part.state?.input },
        classifyReviewBoundaryError(part.state.error),
      )
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
