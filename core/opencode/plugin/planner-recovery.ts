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

function routingAt(root: string): { routing: Record<string, any> | null; selected: string } {
  const vendored = path.join(root, ".opencode", "harness.routing.json")
  const selected = fs.existsSync(vendored) ? vendored : path.join(root, "harness.routing.json")
  try {
    const routing = JSON.parse(fs.readFileSync(selected, "utf8"))
    return { routing: routing && typeof routing === "object" && !Array.isArray(routing) ? routing : null, selected }
  } catch {
    return { routing: null, selected }
  }
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
    prepareCanonicalPlan,
    preparedPlanMatchesArtifacts,
    semanticPlanHash,
    writeBoundPlanSnapshot,
    writePreparedCanonicalPlan,
  } = await import("../lib/planner-artifact.mjs")
  const { bindPlannerArtifact, claimPlannerAttempt, completePlannerAttempt, failPlannerAttempt } = await import("../lib/planner-state.mjs")
  const { buildPlannerBriefAppendix } = await import("./lib/planner-brief.mjs")
  const { dedupeByType, eventForPlanPath, obsAppend } = await import("../lib/obs-emit.mjs")
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { withGateStateLock } = await import("../lib/gate-state.mjs")
  const { validateRouting } = await import("../../shared/lib/routing-validate.mjs")
  const { isCompleteExpectedModelStrategy, projectExpectedModelStrategy } = await import("../../shared/lib/model-strategy-projection.mjs")

  function statePath(sessionId: unknown): string | null {
    if (typeof sessionId !== "string" || !sessionId) return null
    const result = gateStatePath({ projectRoot: root, runtime: "opencode", sessionId })
    return result.ok ? result.path : null
  }

  function providerConfig() {
    const { routing } = routingAt(root)
    if (!routing) return null
    const valid = validateRouting(routing)
    if (!valid.ok) return null
    const projected = projectExpectedModelStrategy(routing)
    if (!projected.ok) return null
    const model = projected.strategy.planner
    return typeof model === "string" ? { model, expectedModelStrategy: projected.strategy } : null
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
      const attemptToken = token()
      let claimError = ""
      const claimed = withGateStateLock(sp, (previous: Record<string, unknown>) => {
        const active = previous.planner_active_attempt as Record<string, unknown> | undefined
        // OC may invoke before twice for one Task. The first claim freezes the strategy;
        // duplicate delivery must never reread or revalidate routing from disk.
        if (active?.call_id === callId && active?.session_id === sessionId) {
          if (!isCompleteExpectedModelStrategy(active.expected_model_strategy) || typeof active.model !== "string" || !active.model) {
            claimError = "active planner attempt has no complete expected model strategy"
            return previous
          }
          return claimPlannerAttempt(previous, {
            role,
            callId,
            token: active.token,
            sessionId,
            featureId: active.feature_id,
            model: active.model,
            expectedModelStrategy: active.expected_model_strategy,
          }).state
        }
        const config = providerConfig()
        if (!config || typeof config.model !== "string" || !config.model.includes("/")) {
          claimError = "routing is missing or invalid"
          return previous
        }
        const featureId = typeof previous.feature_id === "string" ? previous.feature_id : ""
        const baselinePlan = readPlannerArtifact(root, sessionId, featureId)
        const binding = previous.planner_plan_binding as Record<string, unknown> | undefined
        const bound = previous.planner_status === "usable" &&
          binding?.semantic_hash === baselinePlan.semanticHash &&
          binding?.file_hash === baselinePlan.fileHash &&
          binding?.fingerprint === baselinePlan.fingerprint
        const transition = claimPlannerAttempt(previous, {
          role,
          callId,
          token: attemptToken,
          sessionId,
          featureId,
          model: config.model,
          expectedModelStrategy: config.expectedModelStrategy,
          baselinePlan: {
            exists: baselinePlan.exists,
            fingerprint: baselinePlan.fingerprint,
            semanticHash: baselinePlan.semanticHash,
            bound,
          },
          now: now(),
        })
        if (!transition.ok) return { ok: false, reason: transition.reason }
        return transition.state
      })
      if (!claimed.ok) throw new Error(`[planner-recovery] ${claimed.reason}`)
      if (claimError) throw new Error(`[planner-recovery] ${claimError}`)

      // The brief is the ONLY channel into the planner's input. `output.metadata` is an after-hook
      // channel — it informs the orchestrator once the agent already returned — so a revision round
      // would otherwise re-plan blind, and the locked feature identity would stay a guess. Same
      // mechanism plan-gate uses to hand the bound plan to a hand: mutate the dispatch args in place.
      const claimedState = (claimed as { state?: Record<string, unknown> }).state ?? {}
      const claimedAttempt = claimedState.planner_active_attempt as Record<string, unknown> | undefined
      const appendix = buildPlannerBriefAppendix({
        featureId: typeof claimedState.feature_id === "string" ? claimedState.feature_id : "",
        state: claimedState,
        nonce: typeof claimedAttempt?.token === "string" ? claimedAttempt.token : "",
        expectedModelStrategy: claimedAttempt?.expected_model_strategy,
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
      let classified: ReturnType<typeof classifyPlannerResult> = { kind: "invalid_plan", errors: ["planner call has no active strategy"] }
      let planHash: string | undefined
      let accepted = false
      let unchanged = false
      let writeError = ""
      let canonicalPath = ""
      const persisted = withGateStateLock(sp, (previous: Record<string, unknown>) => {
        const active = previous.planner_active_attempt as Record<string, unknown> | undefined
        const stateFeatureId = typeof previous.feature_id === "string" ? previous.feature_id : ""
        if (
          !active ||
          active.call_id !== callId ||
          typeof active.token !== "string" || !active.token ||
          active.session_id !== sessionId ||
          active.feature_id !== stateFeatureId ||
          !isCompleteExpectedModelStrategy(active.expected_model_strategy)
        ) {
          accepted = false
          classified = { kind: "invalid_plan", errors: ["planner active attempt identity or strategy is invalid"] }
          return previous
        }
        const baseline = (active?.baseline_plan ?? {}) as Record<string, unknown>
        const existingBinding = previous.planner_plan_binding as Record<string, unknown> | undefined
        const expectedModelStrategy = active?.expected_model_strategy
        classified = classifyPlannerResult(response, { expectedModelStrategy })
        planHash = classified.kind === "usable_plan" ? semanticPlanHash(classified.plan) : undefined
        // With the plugin authoring the file, a fresh mtime no longer proves the attempt did work.
        // What must still hold: a re-dispatch that returns the plan it was asked to revise, verbatim,
        // has addressed nothing — reject it into the revision loop instead of binding a no-op.
        unchanged =
          classified.kind === "usable_plan" &&
          baseline.bound === true &&
          existingBinding?.semantic_hash === baseline.semanticHash &&
          existingBinding?.fingerprint === baseline.fingerprint &&
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
        const prepared = prepareCanonicalPlan(root, sessionId, featureId, classified.plan, {
          expectedModelStrategy,
          requireExpectedModelStrategy: true,
        })
        if (!prepared.ok) {
          writeError = prepared.reason
          return { ...state, planner_status: "plan_invalid", planner_active_attempt: null, planner_binding_error: writeError }
        }
        const stagedSnapshot = writeBoundPlanSnapshot(root, sessionId, {
          valid: true,
          semanticHash: prepared.semanticHash,
          plan: classified.plan,
          raw: prepared.raw,
        })
        if (!stagedSnapshot.ok) {
          writeError = stagedSnapshot.reason
          return { ...state, planner_status: "plan_invalid", planner_active_attempt: null, planner_binding_error: writeError }
        }
        const written = writePreparedCanonicalPlan(prepared)
        if (!written.ok) {
          writeError = written.reason
          return { ...state, planner_status: "plan_invalid", planner_active_attempt: null, planner_binding_error: writeError }
        }
        const artifact = readPlannerArtifact(root, sessionId, featureId)
        if (!preparedPlanMatchesArtifacts(prepared, artifact, stagedSnapshot.snapshot)) {
          writeError = "canonical artifact bytes differ from the staged bound snapshot"
          return { ...state, planner_status: "plan_invalid", planner_active_attempt: null, planner_binding_error: writeError }
        }
        const bound = bindPlannerArtifact(state, { artifact, sessionId, featureId })
        if (!bound.ok) {
          writeError = bound.reason
          return { ...state, planner_status: "plan_invalid", planner_active_attempt: null, planner_binding_error: writeError }
        }
        canonicalPath = written.path
        return {
          ...bound.state,
          planner_plan_binding: {
            ...bound.state.planner_plan_binding,
            snapshot_path: stagedSnapshot.relativePath,
            snapshot_hash: stagedSnapshot.snapshot.semanticHash,
            snapshot_file_hash: stagedSnapshot.snapshot.fileHash,
          },
        }
      })
      if (!persisted.ok) throw new Error(`[planner-recovery] ${persisted.reason}`)
      if (!accepted) return
      if (canonicalPath) {
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
