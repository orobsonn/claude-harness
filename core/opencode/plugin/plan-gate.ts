/**
 * @description OC plan-gate plugin — full plan required + ADR-003 dual enforcement.
 * Before executor/sniper task dispatch: load plan via planDir + decidePlanGate(expect full),
 * then dual_status must be a recorded attempt.
 * Deny throws [plan-gate]. Fail-closed on unreadable gate-state for delivery hands.
 * Non-executor/sniper roles skip plan require.
 * Load shape matches loop-guard: dynamic import of pure mjs inside Plugin factory
 * (static import of dual-enforcement.mjs breaks OC plugin loader — "export is not a function").
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"

const PREFIX = "[plan-gate]"

/**
 * @description Builds plan-gate hooks (async load of pure plan-decide + dual-enforcement mjs).
 */
export async function createPlanGateHooks(
  projectRoot: string,
): Promise<Pick<Hooks, "tool.execute.before">> {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd()
  const {
    enforceDualFromDiskOrThrow,
    extractHookTaskContext,
    extractSubagentType,
    isDeliveryHandRequiringDual,
    isTaskTool,
    loadGateStateFromDisk,
  } = await import("./lib/dual-enforcement.mjs")
  const { decidePlanGate, throwIfPlanDenied } = await import("./lib/plan-decide.mjs")
  const { planDir } = await import("../../shared/lib/path-helpers.mjs")

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const { toolName, toolArgs, sessionId } = extractHookTaskContext(input, output)
      if (!isTaskTool(toolName)) return

      const subagentType = extractSubagentType(toolArgs)
      if (isDeliveryHandRequiringDual(subagentType)) {
        const sid = sessionId ?? undefined
        const loaded = loadGateStateFromDisk(root, { sessionId: sid })
        if (!loaded.ok) {
          throw new Error(`${PREFIX} gate-state-unreadable: ${loaded.reason}`)
        }
        const state =
          loaded.state != null &&
          typeof loaded.state === "object" &&
          !Array.isArray(loaded.state)
            ? (loaded.state as Record<string, unknown>)
            : {}
        const featureId =
          typeof state.feature_id === "string" ? state.feature_id : undefined
        const pd = planDir({
          projectRoot: root,
          runtime: "opencode",
          sessionId: sid,
          featureId,
        })
        let plan: unknown = null
        if (pd.ok) {
          const planPath = path.join(pd.path, "execution-plan.json")
          try {
            if (fs.existsSync(planPath)) {
              plan = JSON.parse(fs.readFileSync(planPath, "utf8"))
            }
          } catch {
            plan = null
          }
        }
        throwIfPlanDenied(decidePlanGate({ plan, expect: "full" }))
      }

      enforceDualFromDiskOrThrow(PREFIX, {
        projectRoot: root,
        toolName,
        toolArgs,
        sessionId: sessionId ?? undefined,
      })
    },
  }
}

/**
 * @description Resolve project root — never empty string into hooks.
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
 * @description OpenCode plugin factory — named const + default (OC load contract).
 */
export const PlanGate: Plugin = async ({ directory, worktree }: any) => {
  return createPlanGateHooks(resolveProjectRoot(directory, worktree))
}

export default PlanGate
