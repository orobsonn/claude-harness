/** @description Native coordinator boundary that consumes entry-gate denials into one allowlisted ceremony step. */

import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import { gateStatePath } from "../../shared/lib/path-helpers.mjs"
import { validateCeremonyBinding } from "./lib/ceremony-binding.mjs"
import { consumeNextTransition } from "../skills/orchestrating-delivery/ceremony-runtime.mjs"

function response(result: Record<string, unknown>) {
  return {
    title: result.ok ? "ceremony-next: ready" : "ceremony-next: rejected",
    output: JSON.stringify(result, null, 2),
    metadata: result,
  }
}

export const CeremonyCoordinator: Plugin = async ({ directory, worktree }: any) => {
  const { tool } = await import("@opencode-ai/plugin/tool")
  const projectRoot = typeof directory === "string" && directory ? directory : worktree
  const ceremonyNext = tool({
    description: "Consume the exact structured entry-gate ceremony denial and return its single allowlisted coordinator step.",
    args: {
      denial: tool.schema.object({
        code: tool.schema.string(),
        missing_proof: tool.schema.string(),
        next_transition: tool.schema.object({
          phase: tool.schema.string(),
          action: tool.schema.string(),
          marker: tool.schema.string(),
        }),
        reason: tool.schema.string().optional(),
      }),
    },
    async execute(args, context) {
      const sessionID = typeof context.sessionID === "string" ? context.sessionID : ""
      const stateFile = gateStatePath({ projectRoot, runtime: "opencode", sessionId: sessionID })
      if (!stateFile.ok) return response({ ok: false, code: "CEREMONY_TRANSITION_REJECTED", reason: stateFile.reason })
      let state: Record<string, unknown>
      try { state = JSON.parse(fs.readFileSync(stateFile.path, "utf8")) } catch {
        return response({ ok: false, code: "CEREMONY_TRANSITION_REJECTED", reason: "gate-state missing or unreadable" })
      }
      const featureId = typeof state.feature_id === "string" ? state.feature_id : ""
      const current = (marker: "brainstormed" | "adversary_fired") => state[marker] === true && validateCeremonyBinding(state, {
        sessionId: sessionID,
        featureId,
        required: [marker],
      }).ok
      return response(consumeNextTransition(args.denial, {
        brainstormedCurrent: current("brainstormed"),
        adversaryCurrent: current("adversary_fired"),
      }))
    },
  })
  return { tool: { "ceremony-next": ceremonyNext } }
}

export default CeremonyCoordinator
