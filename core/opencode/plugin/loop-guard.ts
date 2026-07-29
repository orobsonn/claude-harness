/** @description OC loop guard: useful family-1 reports count only after execution. */
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import fs from "node:fs"

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
    applyReviewOutcome,
    classifyReviewBoundaryError,
    decidePlanReviewRoundRail,
    reserveReviewAttempt,
    loopCounterKey,
  } = await import("./lib/loop-decide.mjs")
  const { decideReviseNudge } = await import("./lib/revise-nudge.mjs")
  const { decideAdversaryNudge } = await import("./lib/adversary-nudge.mjs")
  const { dedupeByType, obsAppend } = await import("./lib/obs-emit.mjs")
  const { withGateStateLock } = await import("./lib/gate-state.mjs")
  const { reviewAgentIdentity } = await import("../agents/review-catalog.mjs")
  const { gateStatePath, planDir } = await import("../../shared/lib/path-helpers.mjs")
  // Host dual-merge path (#384): finalizeHostDualMerge → driveDualEye (dual-runtime) — not skill-only.
  const {
    dualMergeIntentFromOutcome,
    finalizeHostDualMerge,
  } = await import("./lib/dual-merge.mjs")
  const { extractSubagentType, isTaskTool } = await import("./lib/task-dispatch-identity.mjs")
  const { applyAgentDispatchOutcome, applyGateBlockedDispatch } = await import("../../shared/lib/agent-retry.mjs")
  const { decideCallOutcomeOnce } = await import("../../shared/lib/agent-retry-call.mjs")
  const { parseTaskDispatchIdentity } = await import("./lib/task-dispatch-identity.mjs")
  const { isDeliveryRole } = await import("./lib/roles.mjs")

  /** Every harness Task agent: planner, eyes, hands, close roles. */
  function isHarnessTaskRole(role: string): boolean {
    if (!role) return false
    return Boolean(reviewAgentIdentity(role) || isDeliveryRole(role))
  }

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

  function taskIdOf(args: Record<string, unknown>): string {
    const fromArgs = stringArg(args, "task_id", "taskId")
    if (fromArgs) return fromArgs
    const prompt = typeof args.prompt === "string" ? args.prompt : ""
    const marker = parseTaskDispatchIdentity(prompt)
    return marker.ok ? marker.taskId : ""
  }

  /**
   * Per-callId outcome sticky map (process-local).
   * OC fires both message.part.updated(error) AND tool.execute.after for the same Task —
   * without dedupe, K=3 becomes inflated (3 real fails → 6 counts).
   * Failure wins over success for the same callId.
   */
  const callOutcomes = new Map<string, "success" | "failure">()

  /**
   * Raw plan-reviewer dispatch attempts per session (process-local, mirrors callOutcomes above).
   * Backs the #482 round-rail — deliberately NOT gate-state (no lock, no cross-restart survival):
   * it counts DISPATCH ATTEMPTS, unlike reserveReviewAttempt's persisted, epoch-scoped
   * plan_review_count (useful-outcome accounting), so a review-cap epoch reopen must never reset it.
   */
  const planReviewDispatchCounts = new Map<string, number>()

  function nextPlanReviewDispatchCount(sessionID: string): number {
    const next = (planReviewDispatchCounts.get(sessionID) ?? 0) + 1
    planReviewDispatchCounts.set(sessionID, next)
    return next
  }

  function recordAgentRetry(
    sessionID: string,
    callID: string,
    role: string,
    taskId: string,
    outcome: "success" | "failure",
    failureClass?: string,
    rawError?: unknown,
  ) {
    if (!sessionID || !callID || !role || !isHarnessTaskRole(role)) return
    const dedupeKey = `${sessionID}::${callID}`
    const decision = decideCallOutcomeOnce(callOutcomes, dedupeKey, outcome)
    if (!decision.apply || !decision.outcome) return
    const sp = statePathFor(sessionID)
    if (!sp) return
    // A harness-internal deny means the agent never ran: it is the dispatcher's precondition
    // that failed, not the agent. Charging it to the agent's K=3 quality budget bans an
    // innocent agent for the rest of the feature. Bounded separately instead.
    const gateBlocked = failureClass === "gate_blocked"
    withGateStateLock(sp, (state) => {
      let next = state
      if (gateBlocked) {
        return applyGateBlockedDispatch(next, {
          role,
          taskId,
          reason: typeof rawError === "string" ? rawError : (rawError as { message?: string })?.message,
        }).state
      }
      // If after-hook already reset the counter (false success), re-apply failure once.
      if (decision.undoSuccess) {
        next = applyAgentDispatchOutcome(next, { role, taskId, outcome: "failure" }).state
      } else {
        next = applyAgentDispatchOutcome(next, { role, taskId, outcome: decision.outcome }).state
      }
      return next
    })
  }

  function persistOutcome(input: any, output: any, failureClass?: string, rawError?: unknown) {
    const sessionID = input?.sessionID ?? input?.sessionId ?? ""
    const callID = input?.callID ?? input?.callId ?? ""
    const args = argsOf(input, output)
    const sub = extractSubagentType(args)
    if (!sessionID || !callID) return
    const sp = statePathFor(sessionID)
    if (!sp) return
    const taskId = taskIdOf(args)
    // Unified K=3: count once per callId (error event and after-hook may both fire).
    if (failureClass || rawError) {
      recordAgentRetry(sessionID, callID, sub, taskId, "failure", failureClass, rawError)
    } else if (sub) {
      recordAgentRetry(sessionID, callID, sub, taskId, "success")
    }
    /** @type {ReturnType<typeof dualMergeIntentFromOutcome>} */
    let mergeIntent: ReturnType<typeof dualMergeIntentFromOutcome> = null
    const model =
      typeof args?.model === "string"
        ? args.model
        : typeof output?.metadata?.model === "string"
          ? output.metadata.model
          : undefined
    const identity = reviewAgentIdentity(sub)
    if (!identity) return
    const result = withGateStateLock(sp, (prev) => {
      const outcome = applyReviewOutcome(prev, {
        subagentType: sub,
        sessionId: sessionID,
        featureId: featureOf(args),
        taskId,
        phase: stringArg(args, "phase", "phase"),
        callId: callID,
        response: responseOf(input, output),
        failureClass,
        error: rawError,
        model,
      })
      if (outcome.dualBecameBoth === true) {
        mergeIntent = dualMergeIntentFromOutcome(outcome)
      }
      return outcome.state
    })
    if (!result.ok) throw new Error(`[loop-guard] ${result.reason}`)
    // Deterministic continuation nudge: a REVISE verdict is supposed to keep every writing hand
    // waiting (prose + orchestration discipline as of #483 — nothing in the dispatch gate itself
    // blocks on it anymore), so the loop only advances if the orchestrator re-dispatches the
    // plan-reviewer instead of a writing hand. Injected on the metadata channel (the one OC
    // actually delivers) strictly AFTER the verdict is persisted.
    try {
      const nudge = decideReviseNudge({ state: result.state, subagentType: sub })
      if (nudge.action === "inject" && output != null && typeof output === "object") {
        if (!output.metadata || typeof output.metadata !== "object") output.metadata = {}
        output.metadata.revise_nudge = nudge.context
      }
    } catch {
      /* fail-open — a nudge never blocks review accounting */
    }
    // Same channel, the spec phase's own loop: acceptance of a spec-adversary pass had no
    // definition in code, so it behaved like a coin flip — one session stamped after round 1, the
    // next re-attacked to the cap and froze before the planner ever ran.
    try {
      const surfaceHash = specSurfaceHash(result.state, sessionID, featureOf(args))
      const nudge = decideAdversaryNudge({ state: result.state, subagentType: sub, taskId, surfaceHash })
      if (nudge.action === "inject" && output != null && typeof output === "object") {
        if (!output.metadata || typeof output.metadata !== "object") output.metadata = {}
        output.metadata.adversary_nudge = nudge.context
      }
      // With no deterministic cap, prose is the whole stop mechanism — and prose nobody records
      // fails exactly like prose nobody obeys. Persist the escalation and emit it on the
      // observability feed so an ignored one is visible to the operator instead of invisible.
      if (nudge.action === "inject" && nudge.kind === "escalate") {
        const round = nudge.round
        const reportHash = typeof result.state.primary_review_last_report_hash === "string" ? result.state.primary_review_last_report_hash : ""
        withGateStateLock(sp, (prev) => {
          const already = prev.spec_adversary_escalation as Record<string, unknown> | undefined
          if (already && already.identity_hash === nudge.currentIdentity) return prev
          return {
            ...prev,
            spec_adversary_escalation: {
              round,
              report_hash: reportHash,
              identity_hash: nudge.currentIdentity,
              loop_boundary_identity_hash: nudge.loopBoundaryIdentity,
              surface_hash: surfaceHash,
              at: new Date().toISOString(),
            },
          }
        })
        try {
          obsAppend({ type: "spec-adversary-escalated", round }, { dedupe: dedupeByType })
        } catch {
          /* observability is advisory */
        }
      }
    } catch {
      /* fail-open — a nudge never blocks review accounting */
    }
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

  function specSurfaceHash(state: Record<string, unknown>, runtimeSessionId: string, dispatchedFeatureId: string): string {
    const outcomes = Array.isArray(state.review_outcomes) ? state.review_outcomes : []
    const latest = outcomes.at(-1) as Record<string, unknown> | undefined
    const stateFeatureId = typeof state.feature_id === "string" ? state.feature_id : ""
    const receiptFeatureId = typeof latest?.feature_id === "string" ? latest.feature_id : ""
    const stateSessionId = typeof state.session_id === "string" ? state.session_id : ""
    const receiptSessionId = typeof latest?.session_id === "string" ? latest.session_id : ""
    const featureId = stateFeatureId || receiptFeatureId || dispatchedFeatureId
    const sessionId = stateSessionId || receiptSessionId || runtimeSessionId
    const dir = planDir({ projectRoot: dirSafe, runtime: "opencode", sessionId, featureId })
    if (!dir.ok) return ""
    try {
      return crypto.createHash("sha256").update(fs.readFileSync(`${dir.path}/spec.md`)).digest("hex")
    } catch {
      return ""
    }
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

      if (key === "plan_review_count") {
        // Orchestrator-facing round-rail (#482): counts EVERY plan-reviewer dispatch ATTEMPT,
        // decoupled from reserveReviewAttempt's own reservation-slot accounting below (a separate,
        // already-enforced review-budget concern this issue does not touch — reclassifying a round
        // as "focused verification" cannot dodge this count either, mirroring Claude Code
        // entry-gate.mjs's Fix C). The DENY branch is decided and thrown HERE (the runtime's
        // "tool.execute.before" output type is `{ args }` — no metadata field exists on it, so a
        // throw is the only channel this hook can actually surface). The WARN message is decided
        // from the SAME counter but injected in "tool.execute.after" below, where `output.metadata`
        // really exists on the wire — writing it here would silently vanish, exactly the "dead
        // string nobody reads" bug this issue set out to fix.
        const dispatchCount = nextPlanReviewDispatchCount(sessionID)
        const roundRail = decidePlanReviewRoundRail({ subagentType: sub, count: dispatchCount })
        if (roundRail.decision === "deny") {
          throw new Error(roundRail.reason)
        }
      }

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
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!isTaskTool(input?.tool)) return
      const sessionID = input?.sessionID ?? input?.sessionId ?? ""
      const args = argsOf(input, output)
      const sub = extractSubagentType(args)
      // Round-rail warn (#482): the counter was already incremented in "tool.execute.before"
      // above (same process-local Map, peeked here — never incremented twice); this hook is
      // where `output.metadata` is a real, delivered field, unlike before's `{ args }`-only shape.
      if (sessionID && loopCounterKey(sub) === "plan_review_count") {
        const dispatchCount = planReviewDispatchCounts.get(sessionID) ?? 0
        const roundRail = decidePlanReviewRoundRail({ subagentType: sub, count: dispatchCount })
        if (roundRail.decision === "warn" && output != null && typeof output === "object") {
          if (!output.metadata || typeof output.metadata !== "object") output.metadata = {}
          output.metadata.loop_guard_warning = roundRail.reason
        }
      }
      persistOutcome(input, output)
    },

    event: async ({ event }: any) => {
      if (event?.type !== "message.part.updated") return
      const part = event?.properties?.part
      if (!part || part.type !== "tool" || !isTaskTool(part.tool) || part.state?.status !== "error") return
      persistOutcome(
        { tool: part.tool, sessionID: part.sessionID, callID: part.callID, args: part.state?.input },
        { args: part.state?.input, metadata: part.state?.metadata },
        classifyReviewBoundaryError(part.state.error),
        part.state.error,
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
