/** @description Persist operator autonomy and re-prompt an idle top-level build session through official OpenCode APIs. */
import type { Hooks, Plugin } from "@opencode-ai/plugin"

function textFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  return parts.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
}

function taskRole(args: unknown): string {
  if (!args || typeof args !== "object" || Array.isArray(args)) return ""
  const value = (args as Record<string, unknown>).subagent_type ?? (args as Record<string, unknown>).subagentType
  return typeof value === "string" ? value.trim().toLowerCase() : ""
}

function taskOutput(output: unknown): string {
  if (!output || typeof output !== "object" || Array.isArray(output)) return ""
  const value = (output as Record<string, unknown>).output ?? (output as Record<string, unknown>).content ?? (output as Record<string, unknown>).result
  return typeof value === "string" ? value : ""
}

async function createAutonomyControllerHooks(projectRoot: string, client: any): Promise<Pick<Hooks, "chat.message" | "tool.execute.after" | "event">> {
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { mergeGateState, readGateState } = await import("../lib/gate-state.mjs")
  const { resolveHookArgs } = await import("../lib/obs-emit.mjs")
  const {
    autonomyContinuationPrompt,
    decideAutonomyContinuation,
    detectsAutonomyDirective,
    readOperatorModel,
    readPlanReviewVerdict,
  } = await import("./lib/autonomy-controller.mjs")

  const statePath = (sessionID: unknown) => gateStatePath({ projectRoot, runtime: "opencode", sessionId: sessionID })
  const readState = (sessionID: unknown) => {
    const resolved = statePath(sessionID)
    return resolved.ok ? { path: resolved.path, state: readGateState(resolved.path) } : null
  }

  return {
    "chat.message": async (input: any, output: any) => {
      try {
        if (typeof input?.sessionID !== "string") return
        if (typeof input?.agent === "string" && input.agent !== "build") return
        const text = textFromParts(output?.parts)
        const loaded = readState(input.sessionID)
        if (!loaded) return
        if (text.includes("[HARNESS_AUTONOMY_CONTINUE]")) {
          mergeGateState(loaded.path, { autonomy_continuation: null })
          return
        }
        const operatorModel = readOperatorModel(input?.model, input?.variant)
          ?? readOperatorModel(output?.message?.model, output?.message?.variant ?? input?.variant)
        /** @type {Record<string, unknown>} */
        const patch: Record<string, unknown> = {}
        if (operatorModel) patch.operator_session_model = operatorModel
        if (detectsAutonomyDirective(text)) {
          patch.autonomy_directive = "enabled"
          patch.autonomy_continuation = null
        }
        if (Object.keys(patch).length > 0) mergeGateState(loaded.path, patch)
      } catch {
        /* Autonomy must not make a normal operator message fail. */
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      try {
        const args = resolveHookArgs(input, output) ?? (input?.tool_input && typeof input.tool_input === "object" ? input.tool_input : null)
        if (taskRole(args) !== "plan-reviewer") return
        const verdict = readPlanReviewVerdict(taskOutput(output))
        if (!verdict || typeof input?.sessionID !== "string") return
        const loaded = readState(input.sessionID)
        if (loaded?.state.classified === true) mergeGateState(loaded.path, { plan_review_verdict: verdict })
      } catch {
        /* Eye observation is advisory to continuation and must fail open. */
      }
    },
    event: async ({ event }: any) => {
      try {
        if (event?.type !== "session.idle") return
        const sessionID = event?.properties?.sessionID
        if (typeof sessionID !== "string" || typeof client?.session?.promptAsync !== "function") return
        const loaded = readState(sessionID)
        if (!loaded) return
        const next = decideAutonomyContinuation(loaded.state)
        if (next.action !== "continue") {
          // Clear a stuck claim when the motor has nothing left to drive (e.g. final-review-done).
          if (loaded.state.autonomy_continuation != null) {
            mergeGateState(loaded.path, { autonomy_continuation: null })
          }
          return
        }
        if (loaded.state.autonomy_continuation != null) return
        const claimed = mergeGateState(loaded.path, {
          autonomy_continuation: { phase: next.phase, queued_at: new Date().toISOString() },
        })
        if (!claimed.ok) return
        try {
          // Re-read under the claim: a concurrent final-review stamp must abort the prompt.
          const latest = readState(sessionID)
          const still = latest ? decideAutonomyContinuation(latest.state) : { action: "none" as const }
          if (still.action !== "continue" || still.phase !== next.phase) {
            mergeGateState(loaded.path, { autonomy_continuation: null })
            return
          }
          const operatorModel = readOperatorModel(latest?.state.operator_session_model ?? loaded.state.operator_session_model)
          await client.session.promptAsync({
            path: { id: sessionID },
            query: { directory: projectRoot },
            body: {
              ...(operatorModel
                ? {
                    model: { providerID: operatorModel.providerID, modelID: operatorModel.modelID },
                    agent: "build",
                    ...(operatorModel.variant ? { variant: operatorModel.variant } : {}),
                  }
                : {}),
              parts: [{ type: "text", text: autonomyContinuationPrompt(next.phase) }],
            },
          })
        } catch {
          mergeGateState(loaded.path, { autonomy_continuation: null })
        }
      } catch {
        /* Official event hooks must never block the OpenCode event loop. */
      }
    },
  }
}

/** @description OC load contract — default export only; plugin loader rejects multiple exports. */
const autonomyController: Plugin = async ({ directory, worktree, client }: any) => {
  const projectRoot = typeof directory === "string" && directory ? directory : worktree
  return createAutonomyControllerHooks(projectRoot, client)
}

export default autonomyController
