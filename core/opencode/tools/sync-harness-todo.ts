/** @description Native best-effort todo projection for the current persisted harness state. */

import { tool } from "@opencode-ai/plugin/tool"
import { execFileSync } from "node:child_process"

function isAncestorAtHead(directory: string, sha: string) {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return false
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: directory,
      stdio: "ignore",
      timeout: 2_000,
    })
    return true
  } catch {
    return false
  }
}
import fs from "node:fs"

export default tool({
  description: "Project the current durable harness plan and gate-state into the exact todo list for native todowrite. Call it after a durable phase transition, then immediately call todowrite with its todos. This tool never changes delivery state and failures are non-blocking.",
  args: {},
  async execute(_args, context) {
    try {
      const sessionID = context.sessionID
      const root = context.directory
      if (typeof sessionID !== "string" || !sessionID || typeof root !== "string" || !root) {
        return { title: "harness todo unavailable", output: "{}", metadata: { todos: [] } }
      }
      const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
      const { projectHarnessTodo } = await import("../lib/todo-projection.mjs")
      const { resolvePlannerArtifactPath } = await import("../lib/planner-artifact.mjs")
      const statePath = gateStatePath({ projectRoot: root, runtime: "opencode", sessionId: sessionID })
      if (!statePath.ok) return { title: "harness todo unavailable", output: "{}", metadata: { todos: [] } }
      const state = JSON.parse(fs.readFileSync(statePath.path, "utf8"))
      const featureId = typeof state?.feature_id === "string" ? state.feature_id : ""
      const planPath = resolvePlannerArtifactPath(root, sessionID, featureId, state?.resumed_from_session_id)
      const plan = planPath ? JSON.parse(fs.readFileSync(planPath, "utf8")) : null
      const todos = projectHarnessTodo(plan, state, { isAncestor: (sha: string) => isAncestorAtHead(root, sha) })
      return {
        title: "harness todo projected",
        output: JSON.stringify({ todos }, null, 2),
        metadata: { todos },
      }
    } catch {
      return { title: "harness todo unavailable", output: "{}", metadata: { todos: [] } }
    }
  },
})
