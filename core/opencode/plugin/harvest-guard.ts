/**
 * @description OC harvest-guard — deny harvester task dispatch when findings.md is not a usable file.
 * Intercepts tool `task` with subagent harvester (no `harvest` tool exists). Deny throws [harvest-guard].
 * Resolves project root from directory/worktree — never bare process.cwd for the findings path alone.
 */
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"

const PREFIX = "[harvest-guard]"

/**
 * @description Resolve project root — never empty string into hooks.
 */
export function resolveProjectRoot(directory?: unknown, worktree?: unknown): string {
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
 * @description Extract subagent type from task tool args (snake/camel + nested input).
 */
export function subagentOf(args: unknown): string {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return ""
  const a = args as Record<string, unknown>
  const nested =
    a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
      ? (a.input as Record<string, unknown>)
      : null
  const raw =
    a.subagent_type ?? a.subagentType ?? a.agent ?? nested?.subagent_type ?? nested?.subagentType ?? nested?.agent
  return typeof raw === "string" ? raw : ""
}

/**
 * @description Bare role from subagent type (strip namespace / suffix).
 */
export function bareRole(subagentType: unknown): string {
  if (typeof subagentType !== "string") return ""
  let s = subagentType.trim()
  if (!s) return ""
  if (s.startsWith("@")) s = s.slice(1)
  if (s.includes("/")) s = s.split("/").pop() || s
  if (s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1)
  return s.replace(/\.md$/i, "").toLowerCase()
}

/**
 * @description Whether tool name is the OC task dispatch tool.
 */
export function isTaskTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false
  const n = toolName.toLowerCase()
  return n === "task" || n.endsWith("_task") || n.endsWith(".task")
}

/**
 * @description Whether subagent is the canonical harvester role.
 */
export function isHarvesterRole(subagentType: unknown): boolean {
  return bareRole(subagentType) === "harvester"
}

/**
 * @description Decide harvest precondition on findings.md at project root.
 * Missing, empty, or directory-shaped → deny. Regular non-empty file → allow.
 */
export function decideHarvestFindings(projectRoot: string): {
  ok: boolean
  decision: "allow" | "deny"
  reason: string
  findingsPath: string
} {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd()
  const findingsPath = path.join(root, "findings.md")
  let st: fs.Stats
  try {
    st = fs.statSync(findingsPath)
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: `${PREFIX} Blocked: findings.md missing at ${findingsPath}`,
      findingsPath,
    }
  }
  if (st.isDirectory()) {
    return {
      ok: false,
      decision: "deny",
      reason: `${PREFIX} Blocked: findings.md is a directory at ${findingsPath}`,
      findingsPath,
    }
  }
  if (!st.isFile()) {
    return {
      ok: false,
      decision: "deny",
      reason: `${PREFIX} Blocked: findings.md is not a regular file at ${findingsPath}`,
      findingsPath,
    }
  }
  if (st.size === 0) {
    return {
      ok: false,
      decision: "deny",
      reason: `${PREFIX} Blocked: findings.md is empty at ${findingsPath}`,
      findingsPath,
    }
  }
  return {
    ok: true,
    decision: "allow",
    reason: "findings.md present",
    findingsPath,
  }
}

/**
 * @description Throw when decision is deny (host-real deny path).
 */
export function throwIfHarvestDenied(decision: {
  decision: "allow" | "deny"
  reason: string
}): void {
  if (decision.decision === "deny") {
    throw new Error(decision.reason || `${PREFIX} denied`)
  }
}

/**
 * @description Builds harvest-guard hooks (sync; pure fs check).
 */
export function createHarvestGuardHooks(
  projectRoot: string,
): Pick<Hooks, "tool.execute.before"> {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd()

  return {
    "tool.execute.before": async (input: any, output: any) => {
      if (!isTaskTool(input?.tool)) return
      const args = output?.args ?? input?.args ?? input?.toolArgs ?? input?.tool_input ?? {}
      const sub = subagentOf(args)
      if (!isHarvesterRole(sub)) return
      throwIfHarvestDenied(decideHarvestFindings(root))
    },
  }
}

export const harvestGuard: Plugin = async ({ directory, worktree }: any) => {
  if (process.env.OC_HARVEST_GUARD_OFF === "1") return {}
  return createHarvestGuardHooks(resolveProjectRoot(directory, worktree))
}

/** @description OC load contract — default export required. */
export default harvestGuard
