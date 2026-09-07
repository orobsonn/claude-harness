/** @description Restore validated same-session context through OpenCode's compaction hook. */
import type { Hooks, Plugin } from "@opencode-ai/plugin"

async function createReinjectStateHooks(
  directory?: string,
  worktree?: string,
): Promise<Hooks> {
  const { buildSessionRecovery, resolveSessionProjectRoot } = await import("./lib/session-state.mjs")
  const root = resolveSessionProjectRoot(directory, worktree)
  return {
    "experimental.session.compacting": async (input, output) => {
      if (!root || typeof input?.sessionID !== "string" || !Array.isArray(output?.context)) return
      const recovered = buildSessionRecovery(root, input.sessionID)
      if (recovered.ok) output.context.push(recovered.context)
    },
  }
}

export const reinjectState: Plugin = async ({ directory, worktree }) =>
  createReinjectStateHooks(directory, worktree)
Object.defineProperty(reinjectState, "testApi", { value: Object.freeze({ createReinjectStateHooks }) })

/** @description OC load contract — default export required. */
export default reinjectState;
