/**
 * @description OC plan-gate plugin — full plan required + ADR-003 dual classification.
 * Before plan-reviewer/test-author/executor/sniper dispatch: reconcile one locked artifact snapshot + decidePlanGate(expect full).
 * Dual/plan_verdict classification (enforceDualFromDiskOrThrow) is record-only as of #483 — it
 * never denies dispatch; it only logs and reports dual_status/plan_verdict for observability.
 * Discipline around waiting for plan-review APPROVE is prose + orchestration now (see
 * lib/revise-nudge.mjs), exactly like Claude Code, which has no dual gate on dispatch at all.
 * Deny throws [plan-gate] (from the plan-require block above; never from dual). Conditional on
 * planner_plan_binding: absent (no ceremony ever ran for this session, or a terminated/failed
 * attempt with no binding) -> fail-open, no plan required (operator no-ceremony branch, fleet
 * fix-mode); present -> validated for real, unchanged from before. Gate-state reconciliation
 * failure fails open only for genuinely missing/unreadable state — lock contention or a write
 * failure still denies.
 * Roles outside the guarded downstream set skip plan require.
 * Load shape matches loop-guard: dynamic import of pure mjs inside Plugin factory
 * (static import of dual-enforcement.mjs breaks OC plugin loader — "export is not a function").
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
  const { registerScopeComponent } = await import("./lib/scope-runtime-composition.mjs")
  registerScopeComponent(root, "plan-gate")
  const {
    enforceDualFromDiskOrThrow,
    extractHookTaskContext,
    extractSubagentType,
    isTaskTool,
  } = await import("./lib/dual-enforcement.mjs")
  const { decidePlanGate, throwIfPlanDenied } = await import("./lib/plan-decide.mjs")
  const { reconcilePlannerStateFromDisk } = await import("./lib/planner-artifact.mjs")
  const { parseTaskDispatchIdentity } = await import("./lib/task-dispatch-identity.mjs")
  const { resolveHookIdentity } = await import("./lib/hook-identity.mjs")
  const { validateCeremonyBinding } = await import("./lib/ceremony-binding.mjs")
  const {
    bareRole,
    isExecutorRole,
    isPlanReviewerRole,
    isSniperRole,
    isTestAuthorRole,
  } = await import("./lib/roles.mjs")
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
      if (!identity.ok) throw new Error(`${PREFIX} delivery-blocked: ${identity.reason}`)
      const sessionId = identity.sessionIdSource === "runtime-envelope" ? identity.sessionId : null
      const subagentType = extractSubagentType(toolArgs)
      const role = bareRole(subagentType)
      const requiresFullPlan =
        isPlanReviewerRole(role) ||
        isTestAuthorRole(role) ||
        isExecutorRole(role) ||
        isSniperRole(role)
      // Conditional on binding existence: absent (no planner ceremony ever ran for this
      // session — the operator's no-ceremony branch, or a fix-mode dispatch reusing a
      // branch) -> skip fail-open, no plan required. Present -> validate for real; nothing
      // below this point is relaxed once a real planner attempt is on the table (#ac-1.2, #ac-1.3).
      if (requiresFullPlan) {
        const sid = sessionId ?? undefined
        if (sid) {
          const reconciled = reconcilePlannerStateFromDisk(root, sid)
          if (!reconciled.ok) {
            // #ac-1.4 fail-open is scoped to genuinely missing/unreadable state — lock
            // contention or a write failure is an infra fault, not "no ceremony ran", and
            // must keep denying (a squatted lock must never disable plan validation).
            if (GATE_STATE_INFRA_FAILURE_REASONS.has(String(reconciled.reason))) {
              throw new Error(`${PREFIX} delivery-blocked: gate-state contention (${reconciled.reason})`)
            }
            console.warn(`${PREFIX} planner-state-unreadable (fail-open, plan validation skipped): ${reconciled.reason}`)
          } else {
            const state =
              reconciled.state != null &&
              typeof reconciled.state === "object" &&
              !Array.isArray(reconciled.state)
                ? (reconciled.state as Record<string, unknown>)
                : {}
            const binding = state.planner_plan_binding as Record<string, unknown> | undefined
            if (!binding) {
              // A planner attempt that really ran and ended terminally-blocked (invalid plan,
              // failed/unavailable provider, delivery-blocked) never produces a binding either
              // — but it is NOT "no ceremony ran" and must not be treated as the fail-open case.
              // Mirrors the invariant lib/dispatch-scope.mjs:readCanonicalTaskFromSnapshot already
              // enforces (refuses delivery_status === "delivery-blocked").
              const terminalPlannerStatus = new Set(["plan_invalid", "planner_failed", "planner_unavailable"])
              if (
                state.delivery_status === "delivery-blocked" ||
                terminalPlannerStatus.has(String(state.planner_status ?? ""))
              ) {
                throw new Error(`${PREFIX} delivery-blocked: planner attempt ended in a non-usable state; status=${String(state.planner_status ?? "missing")}`)
              }
            }
            if (binding) {
              const ceremonyBinding = validateCeremonyBinding(state, {
                sessionId: sid,
                featureId: typeof state.feature_id === "string" ? state.feature_id : "",
                required: ["brainstormed", "adversary_fired"],
              })
              if (!ceremonyBinding.ok) {
                throw new Error(`${PREFIX} delivery-blocked: ${ceremonyBinding.reason}`)
              }
              if (state.planner_status !== "usable") {
                throw new Error(`${PREFIX} delivery-blocked: planner usable bound artifact required; status=${String(state.planner_status ?? "missing")}`)
              }
              const artifact = reconciled.artifact as Record<string, unknown> | null
              if (
                !artifact ||
                binding.session_id !== sid ||
                binding.feature_id !== state.feature_id ||
                artifact.semanticHash !== binding.snapshot_hash
              ) {
                throw new Error(`${PREFIX} delivery-blocked: current plan snapshot does not match planner binding`)
              }
              throwIfPlanDenied(decidePlanGate({ plan: artifact.plan, expect: "full" }))
              const ids = dispatchIds(toolArgs)
              const featureId = identity.featureId || ids.featureId
              if (featureId && identity.featureIdSource === "runtime-envelope" && featureId !== binding.feature_id) {
                throw new Error(`${PREFIX} delivery-blocked: trusted runtime feature_id conflicts with bound planner feature`)
              }
              if (ids.featureId && identity.featureIdSource !== "runtime-envelope" && ids.featureId !== binding.feature_id) {
                throw new Error(`${PREFIX} delivery-blocked: optional dispatch feature_id conflicts with bound planner feature`)
              }
              const tasks = Array.isArray((artifact.plan as Record<string, unknown>)?.tasks)
                ? (artifact.plan as { tasks: Array<Record<string, unknown>> }).tasks
                : []
              const requiresTaskId = isTestAuthorRole(role) || isExecutorRole(role) || isSniperRole(role)
              if (requiresTaskId && !marker.ok && identity.taskIdSource !== "runtime-envelope") {
                throw new Error(`${PREFIX} delivery-blocked: ${role} ${String(marker?.reason ?? "task prompt marker missing")}`)
              }
              const trustedTaskId = identity.taskId || ids.taskId
              if (trustedTaskId && !tasks.some((task) => task?.id === trustedTaskId)) {
                throw new Error(`${PREFIX} delivery-blocked: dispatch task_id does not exist in bound plan`)
              }

              if (toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)) {
                const args = toolArgs as Record<string, unknown>
                const existingPrompt = typeof args.prompt === "string" ? args.prompt : ""
                const boundPlan = JSON.stringify(artifact.plan)
                args.prompt = `${existingPrompt}\n\n[HARNESS_BOUND_PLAN sha256=${String(binding.snapshot_hash)}]\n${boundPlan}\n[/HARNESS_BOUND_PLAN]`.trim()
              }
            }
          }
        }
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
