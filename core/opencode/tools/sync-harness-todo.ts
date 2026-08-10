/** @description Native best-effort todo projection for the current persisted harness state. */

import { tool } from "@opencode-ai/plugin/tool"

export default tool({
  description: "Project the current durable harness plan and gate-state into the exact todo list for native todowrite. Call it after a durable phase transition, then immediately call todowrite with its todos. This tool never changes delivery state and failures are non-blocking.",
  args: {},
  async execute(_args, context) {
    try {
      const sessionID = context.sessionID
      const root = context.directory
      if (typeof sessionID !== "string" || !sessionID || typeof root !== "string" || !root) {
        return { title: "harness todo unavailable", output: "{}", metadata: { available: false } }
      }
      const { projectRuntimeTodo } = await import("../lib/runtime-todo-projection.mjs")
      const projection = projectRuntimeTodo(root, sessionID)
      if (!projection.available) return { title: "harness todo unavailable", output: "{}", metadata: { available: false } }
      const todos = projection.todos
      return {
        title: "harness todo projected",
        output: JSON.stringify({ todos }, null, 2),
        metadata: { available: true, todos },
      }
    } catch {
      return { title: "harness todo unavailable", output: "{}", metadata: { available: false } }
    }
  },
})
