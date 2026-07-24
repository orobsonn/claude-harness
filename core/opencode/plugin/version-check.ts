/** @description OC version-check plugin — advisory only, no blocking. Catalog health warn. */
import type { Plugin, PluginInput } from "@opencode-ai/plugin"

type CatalogHealth = {
  missing: string[]
}

type VersionCheckDeps = {
  checkAgentCatalogHealth?: (projectRoot: string) => CatalogHealth
  agentCatalogAdvisoryMessage?: (missing: string[]) => string
  warn?: (message: string) => void
  toastTimeoutMs?: number
}

/** Bootstrap budget for the advisory toast — the TUI may never answer. */
const TOAST_TIMEOUT_MS = 2000

/**
 * @description Usable project root candidate. OpenCode reports worktree "/" outside a git
 * repository, which would resolve the catalog against the filesystem root.
 */
function isUsableRoot(candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && candidate !== "/"
}

/**
 * @description Resolve project root — never empty.
 */
export function resolveProjectRoot(directory?: unknown, worktree?: unknown): string {
  if (isUsableRoot(worktree)) return worktree
  if (isUsableRoot(directory)) return directory
  if (
    directory != null &&
    typeof directory === "object" &&
    !Array.isArray(directory)
  ) {
    const nested = (directory as { directory?: unknown }).directory
    if (isUsableRoot(nested)) return nested
  }
  return process.cwd()
}

/**
 * @description Reject once the budget elapses so a silent TUI cannot stall the bootstrap.
 * @param value toast delivery result — may be a promise that never settles
 * @param timeoutMs budget in milliseconds
 */
async function withToastTimeout<T>(value: T | Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      Promise.resolve(value),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("TUI toast timed out")), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
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
    const toastResult = await withToastTimeout(
      client.tui.showToast({
        body: {
          title: "Harness",
          message,
          variant: "warning",
        },
      }),
      deps.toastTimeoutMs ?? TOAST_TIMEOUT_MS,
    )
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
