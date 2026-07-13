/** @description OC version-check plugin — advisory only, no blocking. Catalog health warn. */
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

type CatalogHealth = {
  missing: string[]
}

type VersionCheckDeps = {
  checkAgentCatalogHealth?: (projectRoot: string) => CatalogHealth
  agentCatalogAdvisoryMessage?: (missing: string[]) => string
  warn?: (message: string) => void
}

/**
 * @description Resolve project root — never empty.
 */
export function resolveProjectRoot(directory?: unknown, worktree?: unknown): string {
  if (typeof worktree === "string" && worktree.length > 0) return worktree
  if (typeof directory === "string" && directory.length > 0) return directory
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
export async function createVersionCheck(
  { directory, worktree, client }: Pick<PluginInput, "directory" | "worktree" | "client">,
  deps: VersionCheckDeps = {},
) {
  const projectRoot = resolveProjectRoot(directory, worktree)
  let message = ""
  try {
    const health = deps.checkAgentCatalogHealth
      ? { checkAgentCatalogHealth: deps.checkAgentCatalogHealth, agentCatalogAdvisoryMessage: deps.agentCatalogAdvisoryMessage }
      : await import("./lib/agent-catalog-health.mjs")
    const { checkAgentCatalogHealth, agentCatalogAdvisoryMessage } = health
    const result = checkAgentCatalogHealth(projectRoot)
    if (result.missing.length === 0) return {}
    message = agentCatalogAdvisoryMessage(result.missing)
    if (!message) return {}
    if (typeof client?.tui?.showToast !== "function") throw new Error("TUI toast unavailable")
    const toastResult = await client.tui.showToast({
      body: {
        title: "Harness",
        message,
        variant: "warning",
      },
    })
    if (toastResult && typeof toastResult === "object" && (toastResult as { error?: unknown }).error) {
      throw new Error("TUI toast unavailable")
    }
  } catch {
    // Catalog health is advisory; retain a visible fallback when the TUI is unavailable.
    try {
      const fallback = message || "[harness] Catálogo de agents incompleto. Re-vendorize o harness (.opencode/) e reabra a sessão. Agents já carregados não são atualizados nesta sessão."
      if (deps.warn) deps.warn(fallback)
      else console.warn(fallback)
    } catch {
      // fail-open
    }
  }
  return {}
}

export const versionCheck: Plugin = async (context) => createVersionCheck(context)

/** @description OC load contract — default export required. */
export default versionCheck
