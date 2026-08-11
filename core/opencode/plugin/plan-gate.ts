/**
 * @description OC plan-gate plugin — full bound plan required before writing roles dispatch.
 * Before plan-reviewer/test-author/executor/sniper dispatch: reconcile one locked artifact snapshot + decidePlanGate(expect full).
 * Discipline around waiting for plan-review APPROVE is prose + orchestration, exactly like
 * Claude Code. Deny throws [plan-gate]. Conditional on
 * planner_plan_binding: absent with no planner lifecycle -> fail-open, no plan required
 * (operator/fix-mode branch, fleet fix-mode); any started lifecycle without a usable binding
 * denies. A present binding is validated for real. Gate-state reconciliation
 * failure fails open only for genuinely unreadable state — lock contention or a write
 * failure still denies.
 * Roles outside the guarded downstream set skip plan require.
 * Load shape uses dynamic imports of pure mjs inside the Plugin factory.
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
const PREFIX = "[plan-gate]"

// lib/gate-state.mjs reason strings for lock/write infra faults (as opposed to a genuinely
// missing/unreadable gate-state) — see withGateStateLock / acquireLock.
const GATE_STATE_INFRA_FAILURE_REASONS = new Set([
  "gate-state-lock-timeout",
  "gate-state-lock-mkdir-failed",
  "gate-state-write-failed",
  "gate-state-fn-threw",
])

function dispatchIds(args: unknown): { featureId: string; taskId: string } {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { featureId: "", taskId: "" }
  const record = args as Record<string, unknown>
  const nested = record.input && typeof record.input === "object" && !Array.isArray(record.input)
    ? record.input as Record<string, unknown>
    : {}
  const stringValue = (value: unknown) => typeof value === "string" ? value : ""
  return {
    featureId: stringValue(record.feature_id ?? record.featureId ?? nested.feature_id ?? nested.featureId),
    // Official Task.task_id is host resume — harness plan task uses taskId/task only.
    taskId: stringValue(record.taskId ?? record.task ?? nested.taskId ?? nested.task),
  }
}

/** @description Replace only one exact terminal bound-plan block with canonical binding bytes. */
function normalizeBoundPlanPrompt(existingPrompt: string, snapshotHash: string, serializedPlan: string): { ok: true; prompt: string } | { ok: false } {
  const planBlock = `[HARNESS_BOUND_PLAN sha256=${snapshotHash}]\n${serializedPlan}\n[/HARNESS_BOUND_PLAN]`
  const hasReservedToken = existingPrompt.includes("[HARNESS_BOUND_PLAN") || existingPrompt.includes("[/HARNESS_BOUND_PLAN]")
  if (!hasReservedToken) return { ok: true, prompt: `${existingPrompt}\n\n${planBlock}`.trim() }
  const opens = [...existingPrompt.matchAll(/(?:^|\n)\[HARNESS_BOUND_PLAN sha256=([0-9a-f]{64})\](?=\r?\n)/g)]
  const closes = [...existingPrompt.matchAll(/(?:^|\n)\[\/HARNESS_BOUND_PLAN\](?=$|\r?\n)/g)]
  if (opens.length !== 1 || closes.length !== 1) return { ok: false }
  const open = opens[0]
  const start = (open.index ?? -1) + (open[0].startsWith("\n") ? 1 : 0)
  const close = closes[0]
  const closeStart = (close.index ?? -1) + (close[0].startsWith("\n") ? 1 : 0)
  // A re-review can reuse the prior Task prompt after the planner has bound a revised snapshot.
  // The binding/artifact above is authoritative; replace this one complete stale transport block
  // rather than rejecting a valid review solely because its old hash no longer matches.
  const suffix = existingPrompt.slice(closeStart + "[/HARNESS_BOUND_PLAN]".length)
  if (start < 0 || closeStart < start || !/^[ \t\r\n]*$/.test(suffix)) return { ok: false }
  return { ok: true, prompt: `${existingPrompt.slice(0, start)}${planBlock}` }
}

/**
 * @description Builds plan-gate hooks (async load of pure plan-decide + identity modules).
 */
async function createPlanGateHooks(
  projectRoot: string,
  deps: { validatePlanFn?: (plan: unknown, options: unknown) => { ok: boolean; errors: string[] } } = {},
): Promise<Pick<Hooks, "tool.execute.before">> {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd()
  const { extractSubagentType, isTaskTool, parseTaskDispatchIdentity } = await import(
    "../lib/task-dispatch-identity.mjs",
  )
  const { extractHookTaskContext, resolveHookIdentity } = await import("./lib/hook-identity.mjs")
  const { decidePlanGate, throwIfPlanDenied } = await import("./lib/plan-decide.mjs")
  const { reconcilePlannerStateFromDisk } = await import("../lib/planner-artifact.mjs")
  const { isCompleteExpectedModelStrategy } = await import("../../shared/lib/model-strategy-projection.mjs")
  const {
    bareRole,
    isExecutorRole,
    isPlanReviewerRole,
    isSniperRole,
    isTestAuthorRole,
  } = await import("../lib/roles.mjs")
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const { toolName, toolArgs } = extractHookTaskContext(input, output)
      if (!isTaskTool(toolName)) return

      const prompt = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
        ? (toolArgs as Record<string, unknown>).prompt
        : undefined
      const marker = parseTaskDispatchIdentity(prompt)
      const identity = resolveHookIdentity({
        input,
        toolArgs,
        promptTaskId: marker.ok ? marker.taskId : "",
      })
      if (!identity.ok) throw new Error(`${PREFIX} denied: ${identity.reason}`)
      const sessionId = identity.sessionIdSource === "runtime-envelope" ? identity.sessionId : null
      const subagentType = extractSubagentType(toolArgs)
      const role = bareRole(subagentType)
      const requiresFullPlan =
        isPlanReviewerRole(role) ||
        isTestAuthorRole(role) ||
        isExecutorRole(role) ||
        isSniperRole(role)
      // No planner lifecycle means operator/fix-mode and remains the narrow fail-open branch.
      // Once a planner attempt exists, only a usable bound snapshot may pass.
      if (requiresFullPlan) {
        const sid = sessionId ?? undefined
        if (sid) {
          const reconciled = reconcilePlannerStateFromDisk(root, sid, Date.now(), { validatePlanFn: deps.validatePlanFn })
          if (!reconciled.ok) {
            // #ac-1.4 fail-open is scoped to genuinely unreadable state — lock
            // contention or a write failure is an infra fault, not "no planner attempt ran", and
            // must keep denying (a squatted lock must never disable plan validation).
            if (GATE_STATE_INFRA_FAILURE_REASONS.has(String(reconciled.reason))) {
              throw new Error(`${PREFIX} denied: gate-state contention (${reconciled.reason})`)
            }
            if (reconciled.reason === "gate-state-unreadable") {
              console.warn(`${PREFIX} planner-state-unreadable (fail-open, plan validation skipped): ${reconciled.reason}`)
            } else {
              throw new Error(`${PREFIX} denied: planner state unavailable (${String(reconciled.reason ?? "unknown")})`)
            }
          } else {
            const state =
              reconciled.state != null &&
              typeof reconciled.state === "object" &&
              !Array.isArray(reconciled.state)
                ? (reconciled.state as Record<string, unknown>)
                : {}
            const binding = state.planner_plan_binding as Record<string, unknown> | undefined
            const expectedModelStrategy = isCompleteExpectedModelStrategy(binding?.expected_model_strategy)
              ? binding.expected_model_strategy
              : isCompleteExpectedModelStrategy((state.planner_last_attempt as Record<string, unknown> | undefined)?.expected_model_strategy)
                ? (state.planner_last_attempt as Record<string, unknown>).expected_model_strategy
                : undefined
            if (!binding) {
              const plannerStatus = String(state.planner_status ?? "")
              if (plannerStatus && plannerStatus !== "not_started") {
                throw new Error(`${PREFIX} denied: planner lifecycle has no usable binding; status=${plannerStatus}`)
              }
            }
            if (binding) {
              if (state.planner_status !== "usable") {
                throw new Error(`${PREFIX} denied: planner usable bound artifact required; status=${String(state.planner_status ?? "missing")}`)
              }
              const artifact = reconciled.artifact as Record<string, unknown> | null
              if (
                !artifact ||
                binding.session_id !== sid ||
                binding.feature_id !== state.feature_id ||
                artifact.semanticHash !== binding.snapshot_hash
              ) {
                throw new Error(`${PREFIX} denied: current plan snapshot does not match planner binding`)
              }
              if (reconciled.validatorFailed === true) {
                console.warn(`${PREFIX} Warning: validator failed internally; opening without a validation decision.`)
              } else {
                const planDecision = decidePlanGate(
                  expectedModelStrategy
                    ? { plan: artifact.plan, expect: "full", expectedModelStrategy }
                    : { plan: artifact.plan, expect: "full" },
                  { validatePlanFn: deps.validatePlanFn },
                )
                if (planDecision.decision === "warn") console.warn(`${PREFIX} ${planDecision.reason}`)
                throwIfPlanDenied(planDecision)
              }
              const ids = dispatchIds(toolArgs)
              const featureId = identity.featureId || ids.featureId
              if (featureId && identity.featureIdSource === "runtime-envelope" && featureId !== binding.feature_id) {
                throw new Error(`${PREFIX} denied: trusted runtime feature_id conflicts with bound planner feature`)
              }
              if (ids.featureId && identity.featureIdSource !== "runtime-envelope" && ids.featureId !== binding.feature_id) {
                throw new Error(`${PREFIX} denied: optional dispatch feature_id conflicts with bound planner feature`)
              }
              const tasks = Array.isArray((artifact.plan as Record<string, unknown>)?.tasks)
                ? (artifact.plan as { tasks: Array<Record<string, unknown>> }).tasks
                : []
              const requiresTaskId = isTestAuthorRole(role) || isExecutorRole(role) || isSniperRole(role)
              if (requiresTaskId && !marker.ok && identity.taskIdSource !== "runtime-envelope") {
                throw new Error(`${PREFIX} denied: ${role} ${String(marker?.reason ?? "task prompt marker missing")}`)
              }
              const trustedTaskId = identity.taskId || ids.taskId
              if (trustedTaskId && !tasks.some((task) => task?.id === trustedTaskId)) {
                throw new Error(`${PREFIX} denied: dispatch task_id does not exist in bound plan`)
              }

              if (toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
                const args = toolArgs as Record<string, unknown>
                const existingPrompt = typeof args.prompt === "string" ? args.prompt : ""
                const normalized = normalizeBoundPlanPrompt(existingPrompt, String(binding.snapshot_hash), JSON.stringify(artifact.plan))
                if (!normalized.ok) {
                  throw new Error(`${PREFIX} denied: conflicting bound-plan prompt marker`)
                }
                args.prompt = normalized.prompt
              }
            }
          }
        }
      }
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
Object.defineProperty(PlanGate, "testApi", { value: Object.freeze({ createPlanGateHooks }) })

export default PlanGate
