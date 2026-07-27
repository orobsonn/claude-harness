/**
 * @description OC entry-gate plugin — ceremony + bash delivery/forge + ADR-003 dual.
 * On tool.execute.before:
 * - bash/shell: decideBashAdvisory (allow + advisory, never denies) then decideBashDelivery
 *   (gate-state from disk)
 * - task: decideEntryTask for executor/sniper. Dual/plan_verdict classification (ADR-003) is
 *   record-only as of #483 and lives entirely in plan-gate.ts, which runs earlier in the
 *   plugin chain (planner-recovery → plan-gate → obs-hand → loop-guard → entry-gate) — a
 *   second call here would be dead code, never reached first.
 * Deny throws [entry-gate]. Bash delivery is fail-OPEN on unreadable/missing gate-state and
 * on a missing/unsafe sessionId (Claude Code parity) — decideBashDelivery's own rails
 * (branch/zero-commits, regate, capture, real-file) still apply against the resulting {}.
 * The sole deliberate fail-closed exception is a CORRUPT regate_pending (present but not a
 * JSON array); hand_finished/capture_verified/regate_passed coerce to [] on a non-array value,
 * mirroring Claude Code exactly. Marker-seal validation is deliberately NOT applied on this
 * bash path (see docs/OC-CC-PARITY-REPORT.md item #32 — per-process-instance seal secret +
 * incident #423 would brick delivery for any session resumed after an OpenCode restart); it
 * remains unchanged on the Task/Agent dispatch branch below.
 * Delivery bash always injects isAncestorFn + listHandRecordsForFeatureFn (cheap lazy
 * closures; decideBashDelivery only invokes them for delivery commands, spawn-hand.mjs
 * dispatches, and the freeze-commit early trigger); gitState (a real git probe) is injected
 * only for delivery commands.
 * Load shape matches loop-guard: dynamic import of pure mjs inside factory
 * (static import of mjs breaks OC plugin loader — "export is not a function").
 */

import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"

const PREFIX = "[entry-gate]"

/**
 * @description Optional injectable seams for tests (git/list/ancestor).
 */
export type EntryGateDeps = {
  gitStateFn?: () => {
    branch?: string | null
    commitsAhead?: number | null
    defaultBranch?: string | null
  } | null
  isAncestorFn?: (sha: string) => boolean | null
  listHandRecordsForFeatureFn?: (featureId: string) => unknown[]
  ceremonyPersistFn?: (statePath: string, mutate: (state: Record<string, unknown>) => Record<string, unknown> | { ok: false; reason: string }) => { ok: boolean; reason?: string }
  /** Resolve parent session id for classify top-level rail (injectable in tests). */
  getSessionParentIdFn?: (sessionId: string) => Promise<string | null>
  /** Acting agent name when known (injectable). */
  resolveActingAgentFn?: (input: unknown, output: unknown) => string | null
}

/**
 * @description Whether tool name is bash or shell (OC variants).
 */
function isBashOrShellTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false
  const n = toolName.toLowerCase()
  return (
    n === "bash" ||
    n === "shell" ||
    n.endsWith("_bash") ||
    n.endsWith(".bash") ||
    n.endsWith("_shell") ||
    n.endsWith(".shell")
  )
}

/** @description Native classify tool (ceremony stamp) — top-level build only. */
function isClassifyTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false
  const n = toolName.toLowerCase()
  return n === "classify" || n.endsWith("_classify") || n.endsWith(".classify")
}

/**
 * @description Extract command string from OC bash tool args.
 */
function extractBashCommand(toolArgs: unknown): unknown {
  if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    return undefined
  }
  const a = toolArgs as Record<string, unknown>
  return a.command ?? a.cmd
}

/** @description Detect shell forms that can replace or mutate execution-plan.json. */
function mutatesExecutionPlan(command: unknown): boolean {
  if (typeof command !== "string" || !/execution-plan\.json/i.test(command)) return false
  return (
    /(?:>|>>)\s*["']?[^\s"']*execution-plan\.json/i.test(command) ||
    /\b(?:cp|mv|rsync|tee|rm|truncate)\b[^\n]*execution-plan\.json/i.test(command) ||
    /\bsed\b[^\n]*\s-i(?:\s|$)[^\n]*execution-plan\.json/i.test(command)
  )
}

/**
 * @description Best-effort feature/task ids from task tool args.
 */
function extractFeatureTaskIds(toolArgs: unknown): {
  featureId?: string
  taskId?: string
} {
  if (toolArgs == null || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    return {}
  }
  const a = toolArgs as Record<string, unknown>
  const nested =
    a.input != null && typeof a.input === "object" && !Array.isArray(a.input)
      ? (a.input as Record<string, unknown>)
      : null
  const featureRaw =
    a.feature_id ?? a.featureId ?? a.feature ?? nested?.feature_id ?? nested?.featureId
  // Official Task.task_id is host resume — harness plan task uses taskId/task only.
  const taskRaw = a.taskId ?? a.task ?? nested?.taskId ?? nested?.task
  return {
    featureId: typeof featureRaw === "string" ? featureRaw : undefined,
    taskId: typeof taskRaw === "string" ? taskRaw : undefined,
  }
}

/**
 * @description Real git runner for computeGitState (trim stdout).
 */
function realGitRunner(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim()
}

/**
 * @description Fail-open git state probe — null on any error.
 */
function defaultGitState(
  computeGitState: (git: (args: string[]) => string) => {
    branch: string | null
    commitsAhead: number | null
    defaultBranch: string | null
  },
): {
  branch: string | null
  commitsAhead: number | null
  defaultBranch: string | null
} | null {
  try {
    return computeGitState(realGitRunner)
  } catch {
    return null
  }
}

/**
 * @description git merge-base --is-ancestor sha HEAD → true / false / null.
 */
function defaultIsAncestor(sha: string): boolean | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch (err: unknown) {
    const status =
      err && typeof err === "object" && "status" in err
        ? (err as { status?: unknown }).status
        : undefined
    if (status === 1) return false
    return null
  }
}

/**
 * @description Builds entry-gate hooks (async load of pure decide mjs).
 * Optional deps override git/list/ancestor seams for tests.
 */
export async function createEntryGateHooks(
  projectRoot: string,
  deps: EntryGateDeps = {},
): Promise<Pick<Hooks, "tool.execute.before">> {
  const root =
    typeof projectRoot === "string" && projectRoot.length > 0
      ? projectRoot
      : process.cwd()
  const {
    extractHookTaskContext,
    isTaskTool,
    loadGateStateFromDisk,
  } = await import("./lib/dual-enforcement.mjs")
  const { parseTaskDispatchIdentity } = await import("./lib/task-dispatch-identity.mjs")
  const { resolveHookIdentity } = await import("./lib/hook-identity.mjs")
  const { validateCeremonyBinding } = await import("./lib/ceremony-binding.mjs")
  const { validatePrivilegedMarkerSeals } = await import("./lib/marker-seal.mjs")
  const { recoverCeremony } = await import("./lib/ceremony-transition.mjs")
  const { gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { withGateStateLock } = await import("./lib/gate-state.mjs")
  const {
    decideBashAdvisory,
    applyAdvisory,
    decideBashDelivery,
    isDeliveryCommand,
    throwIfDenied: throwIfBashDenied,
  } = await import("./lib/bash-decide.mjs")
  const {
    decideEntryTask,
    throwIfDenied: throwIfEntryDenied,
  } = await import("./lib/entry-decide.mjs")
  const { isDeliveryRole, isPlannerRole } = await import("./lib/roles.mjs")
  const { computeGitState } = await import("../../shared/lib/git-state.mjs")
  const { listHandRecordsForFeature } = await import("./lib/hand-records.mjs")

  const gitStateFn =
    deps.gitStateFn ?? (() => defaultGitState(computeGitState))
  const isAncestorFn = deps.isAncestorFn ?? defaultIsAncestor
  const listHandRecordsForFeatureFn =
    deps.listHandRecordsForFeatureFn ??
    ((featureId: string) => listHandRecordsForFeature(root, featureId))
  const getSessionParentIdFn = deps.getSessionParentIdFn
  const resolveActingAgentFn =
    deps.resolveActingAgentFn ??
    ((input: any) => {
      const a =
        input?.agent ??
        input?.agentName ??
        input?.agentID ??
        input?.properties?.agent ??
        null
      return typeof a === "string" && a.trim() ? a.trim() : null
    })

  return {
    "tool.execute.before": async (input: any, output: any) => {
      const { toolName, toolArgs } =
        extractHookTaskContext(input, output)

      const prompt = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
        ? (toolArgs as Record<string, unknown>).prompt
        : undefined
      const promptMarker = parseTaskDispatchIdentity(prompt)
      const identity = resolveHookIdentity({
        input,
        toolArgs,
        promptTaskId: promptMarker.ok ? promptMarker.taskId : "",
      })
      if (!identity.ok) throw new Error(`${PREFIX} ${identity.reason}`)
      const sessionId = identity.sessionIdSource === "runtime-envelope" ? identity.sessionId : null
      const subagentType = extractHookTaskContext(input, output).subagentType

      // classify: top-level build only — hands/eyes/child sessions never start ceremony
      if (isClassifyTool(toolName)) {
        const { decideClassifyAuthority } = await import(
          "../../shared/lib/classify-authority.mjs"
        )
        let parentSessionId: string | null = null
        if (typeof sessionId === "string" && sessionId && typeof getSessionParentIdFn === "function") {
          try {
            parentSessionId = await getSessionParentIdFn(sessionId)
          } catch {
            parentSessionId = null
          }
        }
        const agent = resolveActingAgentFn(input, output)
        const auth = decideClassifyAuthority({
          agent,
          parentSessionId,
          sessionId,
        })
        if (!auth.ok) {
          throw new Error(`${PREFIX} ${auth.reason}`)
        }
        return
      }

      if (isBashOrShellTool(toolName)) {
        const command = extractBashCommand(toolArgs)
        applyAdvisory(decideBashAdvisory({ command, cwd: root }), output)

        const sid =
          typeof sessionId === "string" && sessionId.length > 0
            ? sessionId
            : undefined
        const loaded = loadGateStateFromDisk(root, { sessionId: sid })
        // Fail-open on unreadable/missing gate-state (Claude Code parity): an empty or
        // unreadable gate-state is not itself grounds to block delivery — decideBashDelivery's
        // own rails (branch/commits, regate, capture, real-file) still apply against {}.
        const gateState = loaded.ok ? loaded.state : {}
        // Deliberately NOT validating marker seals on the bash delivery path (reverted after
        // review — see docs/OC-CC-PARITY-REPORT.md item #32 "delivery-marker-seal-process-instance":
        // the seal secret is per-process-instance (marker-seal.mjs), so validating it here would
        // resurrect incident #423 — every marker sealed before an OpenCode restart becomes
        // PERMANENTLY unverifiable, bricking delivery for any resumed session. The parity report's
        // resolved judgment is to remove seal validation from all 3 read sites (this one, the Task
        // branch, plan-gate.ts) + the writers — not partially; removing only here (this issue's
        // scope) while Task/plan-gate keep validating does not reintroduce the brick for THIS path.
        // Claude Code has no marker-seal concept at all (grep marker-seal core/claude-code = 0).
        if (
          gateState != null &&
          typeof gateState === "object" &&
          !Array.isArray(gateState) &&
          (gateState as Record<string, unknown>).planner_status === "usable" &&
          mutatesExecutionPlan(command)
        ) {
          throw new Error(`${PREFIX} Blocked: bound execution-plan.json is immutable until a new planner claim.`)
        }

        /** git branch/commit probe is delivery-only (a real git shellout, fail-open on throw);
         * isAncestorFn and listHandRecordsForFeatureFn are cheap lazy closures always safe to
         * pass — decideBashDelivery only invokes them for delivery commands, spawn-hand.mjs
         * dispatches, and the freeze-commit early trigger. */
        const deliveryExtras: {
          gitState?: ReturnType<typeof gitStateFn>
        } = {}
        if (isDeliveryCommand(command)) {
          try {
            deliveryExtras.gitState = gitStateFn()
          } catch {
            deliveryExtras.gitState = null
          }
        }

        throwIfBashDenied(
          decideBashDelivery({
            command,
            gateState,
            sessionId: sid ?? null,
            isAncestorFn,
            listHandRecordsForFeatureFn,
            ...deliveryExtras,
          }),
        )
        return
      }

      if (!isTaskTool(toolName)) return

      const sid =
        typeof sessionId === "string" && sessionId.length > 0
          ? sessionId
          : undefined
      const loaded = loadGateStateFromDisk(root, { sessionId: sid })
      // Fail-open ONLY when the gate-state FILE ITSELF is unreadable/corrupt (#482, mirrors
      // Claude Code entry-gate.mjs): infra trouble reading gate-state.json is not evidence the
      // dispatch itself is unsafe, and the real cost ceiling lives in the fleet engine
      // (cron-a-exit.mjs/cron-review.mjs), outside the session. A missing/unsafe SESSION
      // IDENTITY ("sessionId required…", "unsafe sessionId") is a different, foundational
      // problem — we cannot know whose ceremony to even check — and stays fail-closed.
      const gateStateUnreadable =
        !loaded.ok && typeof loaded.reason === "string" && loaded.reason.startsWith("gate-state")
      if (!loaded.ok && isDeliveryRole(subagentType)) {
        if (gateStateUnreadable) {
          console.error(`${PREFIX} gate-state unreadable, allowing dispatch: ${loaded.reason}`)
        } else {
          throw new Error(`${PREFIX} ${loaded.reason}`)
        }
      }
      let gateState = loaded.ok ? loaded.state : {}

      if (loaded.ok && isPlannerRole(subagentType) && sid) {
        const stateFile = gateStatePath({ projectRoot: root, runtime: "opencode", sessionId: sid })
        if (!stateFile.ok) throw new Error(`${PREFIX} ${stateFile.reason}`)
        const persist = deps.ceremonyPersistFn ?? ((file, mutate) => withGateStateLock(file, mutate))
        // One atomic recovery pass (no cross-call retry loop): recoverCeremony already advances
        // every provable phase in one in-memory pass, so a single lock round-trip persists whatever
        // recovered before the first missing/invalid proof, then reports that proof — instead of the
        // old per-phase while(true) that re-acquired the lock once per phase and left the planner's
        // own gate CEREMONY_PROOF_REQUIRED denial unreachable in decideEntryTask.
        let recoveryError: Record<string, unknown> | null = null
        const persisted = persist(stateFile.path, (previous) => {
          const recovery = recoverCeremony(root, previous)
          if (!recovery.ok) recoveryError = recovery.error
          return recovery.changed ? recovery.state : previous
        })
        if (!persisted.ok) {
          throw new Error(`${PREFIX} ${JSON.stringify({ code: "CEREMONY_PERSIST_FAILED", missing_proof: null, next_transition: null, reason: persisted.reason ?? "gate-state persistence failed" })}`)
        }
        if (recoveryError) throw new Error(`${PREFIX} ${JSON.stringify(recoveryError)}`)
        gateState = persisted.state ?? gateState
      }
      if (loaded.ok && isDeliveryRole(subagentType)) {
        const seals = validatePrivilegedMarkerSeals(gateState, {
          sessionId: sid,
          featureId: typeof gateState.feature_id === "string" ? gateState.feature_id : "",
        })
        if (!seals.ok) throw new Error(`${PREFIX} ${seals.reason}`)
      }
      const optionalIds = extractFeatureTaskIds(toolArgs)
      const featureId = identity.featureIdSource === "runtime-envelope"
        ? identity.featureId
        : typeof gateState.feature_id === "string" ? gateState.feature_id : optionalIds.featureId
      const taskId = identity.taskId || optionalIds.taskId
      // What THIS dispatch declares as its planning target, independent of gate-state's own
      // (possibly stale) feature_id. `featureId` above always collapses to gateState.feature_id
      // once one exists, which would make decideEntryTask's planner featureMismatch check a
      // tautology (always comparing gateState.feature_id to itself); this stays independent so a
      // genuine mismatch — a planner Task declaring a DIFFERENT feature than the one whose
      // ceremony gate-state already carries — is actually reachable.
      const dispatchFeatureId = identity.featureIdSource === "runtime-envelope"
        ? identity.featureId
        : optionalIds.featureId
      const binding = validateCeremonyBinding(gateState, {
        sessionId: sid,
        featureId,
        required: isDeliveryRole(subagentType) ? ["brainstormed", "adversary_fired"] : [],
      })
      if (!binding.ok) throw new Error(`${PREFIX} ${binding.reason}`)

      // review_cap_reached / primary_failure_cap_reached no longer freeze writing hands (#482):
      // decideReviewCapBeforeWriting is removed. The review reservation budget itself (reserved
      // in loop-decide.mjs) still requires a verified restart before another review round — that
      // is a separate, still-enforced concern — but executor/sniper/test-author dispatch proceeds.

      throwIfEntryDenied(
        decideEntryTask({
          subagentType,
          gateState,
          featureId,
          dispatchFeatureId,
          taskId,
        }),
      )
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
export const EntryGate: Plugin = async ({ directory, worktree, client }: any) => {
  const root = resolveProjectRoot(directory, worktree)
  const getSessionParentIdFn = async (sessionId: string): Promise<string | null> => {
    if (typeof client?.session?.get !== "function") return null
    try {
      const res = await client.session.get({
        path: { id: sessionId },
        query: { directory: root },
      })
      const session =
        res && typeof res === "object" && "data" in res
          ? (res as { data?: unknown }).data
          : res
      const parent =
        session && typeof session === "object"
          ? (session as { parentID?: unknown }).parentID
          : null
      return typeof parent === "string" && parent.trim() ? parent.trim() : null
    } catch {
      return null
    }
  }
  return createEntryGateHooks(root, { getSessionParentIdFn })
}

export default EntryGate
