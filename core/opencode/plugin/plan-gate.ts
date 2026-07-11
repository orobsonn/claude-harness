/** @description OC plan-gate plugin — require full plan (expect full) before executor task dispatch. */
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const subagentOf = (args: any): string =>
  args?.subagent_type ?? args?.subagentType ?? args?.agent ?? ""

/**
 * @description Builds plan-gate hooks (async load of pure mjs).
 */
export async function createPlanGateHooks(
  directory: string,
): Promise<Pick<Hooks, "tool.execute.before">> {
  const dirSafe = typeof directory === "string" ? directory : ""

  const { decidePlanGate, throwIfPlanDenied } = await import("./lib/plan-decide.mjs")
  const { isExecutorRole } = await import("./lib/roles.mjs")
  const { isSafeFeatureId, isSafeSessionId } = await import("../../shared/lib/feature-id.mjs")
  const { planDir, gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { readGateState } = await import("./lib/gate-state.mjs")

  function loadPlan(sessionID: string, featureId: string): unknown | null {
    if (!isSafeSessionId(sessionID) || !isSafeFeatureId(featureId)) return null
    const pd = planDir({
      projectRoot: dirSafe,
      runtime: "opencode",
      sessionId: sessionID,
      featureId,
    })
    if (!pd.ok) return null
    const planPath = join(pd.path, "execution-plan.json")
    if (!existsSync(planPath)) return null
    try {
      return JSON.parse(readFileSync(planPath, "utf8"))
    } catch {
      return null
    }
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (input?.tool !== "task") return
      const sessionID = input?.sessionID ?? ""
      if (!sessionID) return
      const sub = subagentOf(output?.args)
      if (!isExecutorRole(sub)) return

      const spRes = gateStatePath({
        projectRoot: dirSafe,
        runtime: "opencode",
        sessionId: sessionID,
      })
      const gs = spRes.ok ? readGateState(spRes.path) : {}
      const featureId =
        typeof gs.feature_id === "string"
          ? gs.feature_id
          : typeof output?.args?.feature_id === "string"
            ? output.args.feature_id
            : ""

      const plan = featureId ? loadPlan(sessionID, featureId) : null
      const decision = decidePlanGate({ plan, expect: "full" })
      throwIfPlanDenied(decision)
    },
  }
}

export const PlanGate: Plugin = async ({ directory, worktree }: any) => {
  if (process.env.OC_PLAN_GATE_OFF === "1") return {}
  const dir: string =
    typeof directory === "string"
      ? directory
      : typeof worktree === "string"
        ? worktree
        : String((directory as any)?.directory ?? "")
  return createPlanGateHooks(dir)
}

export default PlanGate
