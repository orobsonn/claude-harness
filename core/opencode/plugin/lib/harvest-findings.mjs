/**
 * @description Pure harvest findings.md preconditions (shared by harvest-guard plugin + tests).
 */
import { statSync } from "node:fs"
import { join } from "node:path"

const PREFIX = "[harvest-guard]"

/**
 * @description Resolve project root — never empty string into hooks.
 * @param {unknown} [directory]
 * @param {unknown} [worktree]
 * @returns {string}
 */
export function resolveProjectRoot(directory, worktree) {
  if (typeof directory === "string" && directory.length > 0) return directory
  if (typeof worktree === "string" && worktree.length > 0) return worktree
  if (directory != null && typeof directory === "object" && !Array.isArray(directory)) {
    const nested = /** @type {{ directory?: unknown }} */ (directory).directory
    if (typeof nested === "string" && nested.length > 0) return nested
  }
  return process.cwd()
}

/**
 * @param {unknown} args
 * @returns {string}
 */
export function subagentOf(args) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) return ""
  const a = /** @type {Record<string, unknown>} */ (args)
  const nested =
    a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
      ? /** @type {Record<string, unknown>} */ (a.input)
      : null
  const raw =
    a.subagent_type ?? a.subagentType ?? a.agent ?? nested?.subagent_type ?? nested?.subagentType ?? nested?.agent
  return typeof raw === "string" ? raw : ""
}

/**
 * @param {unknown} subagentType
 * @returns {string}
 */
export function bareRole(subagentType) {
  if (typeof subagentType !== "string") return ""
  let s = subagentType.trim()
  if (!s) return ""
  if (s.startsWith("@")) s = s.slice(1)
  if (s.includes("/")) s = s.split("/").pop() || s
  if (s.includes(":")) s = s.slice(s.lastIndexOf(":") + 1)
  return s.replace(/\.md$/i, "").toLowerCase()
}

/**
 * @param {unknown} toolName
 * @returns {boolean}
 */
export function isTaskTool(toolName) {
  if (typeof toolName !== "string") return false
  const n = toolName.toLowerCase()
  return n === "task" || n.endsWith("_task") || n.endsWith(".task")
}

/**
 * @param {unknown} subagentType
 * @returns {boolean}
 */
export function isHarvesterRole(subagentType) {
  return bareRole(subagentType) === "harvester"
}

/**
 * @param {string} projectRoot
 * @returns {{ ok: boolean, decision: "allow"|"deny", reason: string, findingsPath: string }}
 */
export function decideHarvestFindings(projectRoot) {
  const root = typeof projectRoot === "string" && projectRoot.length > 0 ? projectRoot : process.cwd()
  const findingsPath = join(root, "findings.md")
  try {
    const st = statSync(findingsPath)
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
    return { ok: true, decision: "allow", reason: "findings.md present", findingsPath }
  } catch {
    return {
      ok: false,
      decision: "deny",
      reason: `${PREFIX} Blocked: findings.md missing at ${findingsPath}`,
      findingsPath,
    }
  }
}

/**
 * @param {{ decision: "allow"|"deny", reason: string }} decision
 */
export function throwIfHarvestDenied(decision) {
  if (decision.decision === "deny") {
    throw new Error(decision.reason || `${PREFIX} denied`)
  }
}

/**
 * @param {string} projectRoot
 * @returns {{ "tool.execute.before": Function }}
 */
export function createHarvestGuardHooks(projectRoot) {
  const root = typeof projectRoot === "string" && projectRoot.length > 0 ? projectRoot : process.cwd()
  return {
    "tool.execute.before": async (input, output) => {
      if (!isTaskTool(input?.tool)) return
      const args = output?.args ?? input?.args ?? input?.toolArgs ?? input?.tool_input ?? {}
      if (!isHarvesterRole(subagentOf(args))) return
      throwIfHarvestDenied(decideHarvestFindings(root))
    },
  }
}
