/**
 * @description Claims planner calls before dispatch, observes successful output and real ToolStateError events,
 * and persists a leased, callID-bound recovery state machine.
 */
import type { Hooks, Plugin } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function taskTool(name: unknown): boolean {
  if (typeof name !== "string") return false
  const normalized = name.toLowerCase()
  return normalized === "task" || normalized === "agent" || normalized.endsWith(".task") || normalized.endsWith(".agent")
}

function argsOf(input: any, output: any): Record<string, unknown> {
  const value = output?.args ?? input?.args ?? input?.toolArgs ?? input?.tool_input ?? {}
  return value && typeof value === "object" && !Array.isArray(value) ? value : {}
}

function roleOf(args: Record<string, unknown>): string {
  const value = args.subagent_type ?? args.subagentType ?? args.agent
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function readJson(file: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function routingAt(root: string): Record<string, any> | null {
  return readJson(path.join(root, ".opencode", "harness.routing.json")) ?? readJson(path.join(root, "harness.routing.json"))
}

/** @description Build durable planner hooks, including the documented OpenCode ToolStateError event boundary. */
export async function createPlannerRecoveryHooks(
  projectRoot: string,
  deps: { now?: () => number; token?: () => string } = {},
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after" | "event">> {
  const root = typeof projectRoot === "string" && projectRoot ? projectRoot : process.cwd()
  const now = deps.now ?? Date.now
  const token = deps.token ?? (() => crypto.randomUUID())
  const { classifyPlannerBoundaryError, classifyPlannerResult } = await import("./lib/planner-result.mjs")
  const {
    readPlannerArtifact,
    reconcilePlannerStateFromDisk,
    semanticPlanHash,
    writeCanonicalPlan,
  } = await import("../lib/planner-artifact.mjs")
  const { claimPlannerAttempt, completePlannerAttempt, failPlannerAttempt } = await import("../lib/planner-state.mjs")
  const { buildPlannerBriefAppendix } = await import("./lib/planner-brief.mjs")
  const { dedupeByType, eventForPlanPath, obsAppend } = await import("../lib/obs-emit.mjs")
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { withGateStateLock } = await import("../lib/gate-state.mjs")

  function statePath(sessionId: unknown): string | null {
    if (typeof sessionId !== "string" || !sessionId) return null
    const result = gateStatePath({ projectRoot: root, runtime: "opencode", sessionId })
    return result.ok ? result.path : null
  }

  function providerConfig() {
    const routing = routingAt(root)
    const primaryModel = routing?.roles?.planner?.model
    return {
      model: primaryModel,
    }
  }

  function persistBoundaryFailure(partSessionId: string, callId: string, error: unknown) {
    const sp = statePath(partSessionId)
    if (!sp) return { ok: false, reason: "planner failure has no persistent gate-state" }
    const classified = classifyPlannerBoundaryError(error)
    let accepted = false
    const persisted = withGateStateLock(sp, (previous: Record<string, unknown>) => {
      const active = previous.planner_active_attempt as Record<string, unknown> | undefined
      if (
        active?.call_id !== callId ||
        active?.session_id !== partSessionId
      ) {
        accepted = false
        return previous
      }
      const transition = failPlannerAttempt(previous, {
        callId,
        failureClass: classified.failureClass,
        providerUnavailable: classified.kind === "provider_failure",
        now: now(),
      })
      accepted = transition.accepted
      return transition.state
    })
    return { ...persisted, accepted }
  }

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (!taskTool(input?.tool)) return
      const role = roleOf(argsOf(input, output))
      if (role !== "planner") return
      const sessionId = input?.sessionID
      const callId = input?.callID
      const sp = statePath(sessionId)
      if (!sp || typeof callId !== "string" || !callId) {
        throw new Error("[planner-recovery] planner dispatch requires sessionID and callID")
      }
      const config = providerConfig()
      if (typeof config.model !== "string" || !config.model.includes("/")) {
        throw new Error("[planner-recovery] planner model is not configured")
      }

      const attemptToken = token()
      const claimed = withGateStateLock(sp, (previous: Record<string, unknown>) => {
        const featureId = typeof previous.feature_id === "string" ? previous.feature_id : ""
        const baselinePlan = readPlannerArtifact(root, sessionId, featureId)
        const transition = claimPlannerAttempt(previous, {
          role,
          callId,
          token: attemptToken,
          sessionId,
          featureId,
          model: config.model,
          baselinePlan: {
            exists: baselinePlan.exists,
            fingerprint: baselinePlan.fingerprint,
            semanticHash: baselinePlan.semanticHash,
          },
          now: now(),
        })
        if (!transition.ok) return { ok: false, reason: transition.reason }
        return transition.state
      })
      if (!claimed.ok) throw new Error(`[planner-recovery] ${claimed.reason}`)

      // The brief is the ONLY channel into the planner's input. `output.metadata` is an after-hook
      // channel — it informs the orchestrator once the agent already returned — so a revision round
      // would otherwise re-plan blind, and the locked feature identity would stay a guess. Same
      // mechanism plan-gate uses to hand the bound plan to a hand: mutate the dispatch args in place.
      const claimedState = (claimed as { state?: Record<string, unknown> }).state ?? {}
      const appendix = buildPlannerBriefAppendix({
        featureId: typeof claimedState.feature_id === "string" ? claimedState.feature_id : "",
        state: claimedState,
        nonce: attemptToken,
      })
      const args = argsOf(input, output)
      const existing = typeof args.prompt === "string" ? args.prompt : ""
      // OC 1.18 can fire this hook twice for one Task (plugin listed in opencode.json AND
      // auto-loaded from .opencode/plugin/) — the same reason claimPlannerAttempt has an idempotent
      // re-entry path. Appending twice would double an ~8 KB brief on the most expensive agent in
      // the pipeline and fence the instructions twice under MISMATCHED nonces. Same-reference
      // mutation is what makes this marker check reliable.
      if (appendix && !existing.includes("[HARNESS_SESSION_FEATURE_ID]")) {
        args.prompt = `${existing}\n\n${appendix}`.trim()
      }
    },

    "tool.execute.after": async (input: any, output: any) => {
      if (!taskTool(input?.tool)) return
      const role = roleOf(argsOf(input, output))
      if (role !== "planner") return
      const sessionId = input?.sessionID
      const callId = input?.callID
      const sp = statePath(sessionId)
      if (!sp || typeof callId !== "string" || !callId) {
        throw new Error("[planner-recovery] planner result requires sessionID and callID")
      }
      const response = output?.output ?? output?.content ?? output?.result ?? output?.tool_output ?? ""
      const classified = classifyPlannerResult(response)
      const planHash = classified.kind === "usable_plan" ? semanticPlanHash(classified.plan) : undefined
      let accepted = false
      let unchanged = false
      let writeError = ""
      let canonicalPath = ""
      const persisted = withGateStateLock(sp, (previous: Record<string, unknown>) => {
        const active = previous.planner_active_attempt as Record<string, unknown> | undefined
        const baseline = (active?.baseline_plan ?? {}) as Record<string, unknown>
        // With the plugin authoring the file, a fresh mtime no longer proves the attempt did work.
        // What must still hold: a re-dispatch that returns the plan it was asked to revise, verbatim,
        // has addressed nothing — reject it into the revision loop instead of binding a no-op.
        unchanged =
          classified.kind === "usable_plan" &&
          typeof baseline.semanticHash === "string" &&
          baseline.semanticHash === planHash
        const transition = completePlannerAttempt(previous, {
          callId,
          token: active?.call_id === callId ? active.token : undefined,
          resultKind: unchanged ? "invalid_plan" : classified.kind,
          planHash: unchanged ? undefined : planHash,
          errors: unchanged
            ? ["planner returned the plan unchanged; the requested revision was not applied"]
            : classified.kind === "invalid_plan"
              ? classified.errors
              : undefined,
          now: now(),
        })
        accepted = transition.accepted
        if (!accepted || unchanged || classified.kind !== "usable_plan") return transition.state
        // The plugin owns the canonical artifact. The returned plan never round-trips through the
        // orchestrator's output tokens, so it cannot be paraphrased, truncated, or silently dropped
        // — the failure mode that stranded a run at plan_pending_write with every dispatch gated.
        const state = transition.state as Record<string, unknown>
        const featureId = typeof state.feature_id === "string" ? state.feature_id : ""
        const binding = state.planner_plan_binding as Record<string, unknown> | null | undefined
        // OC 1.18 can fire this hook twice for one Task — never rewrite an already-bound identical plan.
        if (state.planner_status === "usable" && binding?.semantic_hash === planHash) return state
        const written = writeCanonicalPlan(root, sessionId, featureId, classified.plan)
        if (written.ok) {
          canonicalPath = written.path
          return state
        }
        writeError = written.reason
        return {
          ...state,
          planner_status: "plan_invalid",
          planner_active_attempt: null,
          planner_binding_error: written.reason,
        }
      })
      if (!persisted.ok) throw new Error(`[planner-recovery] ${persisted.reason}`)
      if (!accepted) return
      if (canonicalPath) {
        // Author and binder in one hook: no dispatch can observe a transient plan_pending_write.
        try {
          reconcilePlannerStateFromDisk(root, sessionId)
        } catch {
          /* plan-gate reconciles again before any downstream dispatch */
        }
        try {
          const event = eventForPlanPath(canonicalPath)
          if (event) {
            const tasks = (classified as { plan?: { tasks?: unknown } }).plan?.tasks
            if (Array.isArray(tasks)) (event as { tasks?: number }).tasks = tasks.length
            obsAppend(event, { dedupe: dedupeByType })
          }
        } catch {
          /* observability is fail-open */
        }
      }
      if (!output.metadata || typeof output.metadata !== "object") output.metadata = {}
      output.metadata.planner_recovery = classified.kind === "usable_plan"
        ? unchanged
          ? "Plano recusado: veio idêntico ao que se pediu para revisar. Redespache o planner com os achados explícitos."
          : writeError
            ? `Plano recusado: não pôde ser gravado como artefato canônico (${writeError}). Corrija com o planner; não escreva o arquivo à mão.`
            : "Plano gravado e vinculado pelo harness no caminho canônico. NÃO reescreva o artefato — siga para validate-plan e plan-reviewer."
        : "Plano inválido: corrija com o planner antes de avançar."
    },

    event: async ({ event }: any) => {
      if (event?.type !== "message.part.updated") return
      const part = event?.properties?.part
      if (!part || part.type !== "tool" || !taskTool(part.tool) || part.state?.status !== "error") return
      if (typeof part.sessionID !== "string" || typeof part.callID !== "string") return
      persistBoundaryFailure(part.sessionID, part.callID, part.state.error)
    },
  }
}

export const PlannerRecovery: Plugin = async ({ directory, worktree }: any) => createPlannerRecoveryHooks(
  typeof directory === "string" && directory ? directory : typeof worktree === "string" ? worktree : process.cwd(),
)

export default PlannerRecovery
