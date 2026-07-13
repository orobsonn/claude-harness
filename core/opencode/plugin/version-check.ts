/** @description OC version-check plugin — advisory only, no blocking. Catalog health warn. */
import type { Plugin } from "@opencode-ai/plugin"

/**
 * @description Resolve project root — never empty.
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

/**
 * @description OpenCode plugin — advisory catalog + version checks (fail-open).
 */
export const versionCheck: Plugin = async ({ directory, worktree }: any) => {
  const projectRoot = resolveProjectRoot(directory, worktree)
  let warned = false

  return {
    "chat.message": async (_input: unknown, _output: unknown) => {
      if (warned) return
      try {
        const {
          checkAgentCatalogHealth,
          agentCatalogAdvisoryMessage,
        } = await import("./lib/agent-catalog-health.mjs")
        const result = checkAgentCatalogHealth(projectRoot)
        if (result.missing.length === 0) return
        const msg = agentCatalogAdvisoryMessage(result.missing)
        if (!msg) return
        warned = true
        // Advisory only — never block chat.
        console.warn(msg)
      } catch {
        // fail-open
      }
    },
  }
}

/** @description OC load contract — default export required. */
export default versionCheck
