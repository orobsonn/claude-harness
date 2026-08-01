/**
 * @description OC entry-gate plugin — plain persisted planner facts + bash delivery/forge.
 * On tool.execute.before:
 * - bash/shell: decideBashAdvisory (allow + advisory, never denies) then decideBashDelivery
 *   (gate-state from disk via lib/gate-state.mjs)
 * - task: decideEntryTask for executor/sniper. Dual/plan_verdict classification (ADR-003) is
 *   record-only as of #483 and lives entirely in plan-gate.ts, which runs earlier in the
 *   plugin chain (planner-recovery → plan-gate → obs-hand → entry-gate) — a
 *   second call here would be dead code, never reached first. Shared utils used by this
 *   gate (isTaskTool, extractHookTaskContext, loadGateStateFromDisk) live outside
 *   dual-enforcement (#580); #583 removes the dual block from plan-gate.
 * Deny throws [entry-gate]. Bash delivery is fail-OPEN on unreadable/missing gate-state and
 * on a missing/unsafe sessionId (Claude Code parity) — decideBashDelivery's own rails
 * (branch/zero-commits, regate, capture, real-file) still apply against the resulting {}.
 * The sole deliberate fail-closed exception is a CORRUPT regate_pending (present but not a
 * JSON array); hand_finished/capture_verified/regate_passed coerce to [] on a non-array value,
 * mirroring Claude Code exactly. Marker-seal validation is not applied anywhere (bash or
 * Task/Agent dispatch) — see docs/OC-CC-PARITY-REPORT.md item #32: the seal secret was
 * per-process-instance, so a fresh OpenCode process could never verify a marker sealed
 * before it started, bricking delivery for any session resumed after a restart (#423).
 * Delivery bash always injects isAncestorFn + listHandRecordsForFeatureFn (cheap lazy
 * closures; decideBashDelivery only invokes them for delivery commands, spawn-hand.mjs
 * dispatches, and the freeze-commit early trigger); gitState (a real git probe) is injected
 * only for delivery commands.
 * Load shape uses dynamic imports of pure mjs inside the factory.
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

/** @description Native classify tool — top-level build only. */
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
  const { isTaskTool, parseTaskDispatchIdentity } = await import("../lib/task-dispatch-identity.mjs")
  const { extractHookTaskContext, resolveHookIdentity } = await import("./lib/hook-identity.mjs")
  const { loadGateStateFromDisk } = await import("../lib/gate-state.mjs")
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
  } = await import("../lib/entry-decide.mjs")
  const { isDeliveryRole } = await import("../lib/roles.mjs")
  const { computeGitState } = await import("../../shared/lib/git-state.mjs")
  const { listHandRecordsForFeature } = await import("../lib/hand-records.mjs")

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

      // classify: top-level build only — hands/eyes/child sessions never classify
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

        // [#516] Belt-and-suspenders choke-point: re-checks the raw command against the
        // fleet-hardened DANGEROUS_BASH_DENYLIST directly (core/shared/lib/dangerous-bash-denylist.mjs),
        // independent of whatever config.permission.bash the OC config merge (global ruleset ∪
        // per-agent frontmatter) actually resolved to. This closes the load-bearing gap the
        // denylist's own JSDoc documented: OpenCode resolves permission.bash with `findLast`
        // (last match wins), and every agent the fleet actually dispatches
        // (`opencode run --agent build`) used to declare its own `bash: allow` in frontmatter,
        // which is merged AFTER the global ruleset and therefore shadowed every deny in the
        // denylist for that agent. Part 1 of #516 removed those redundant per-agent overrides;
        // this check survives even if a future agent is authored with `bash: allow` again, before
        // the agents permission-lockdown test catches it in CI.
        // Deliberately scoped to fleet dispatch only, keyed SOLELY on HARNESS_NOTIFY_PROJECT — the
        // one signal `core/vps/cron-a-dispatch.mjs` sets UNCONDITIONALLY for every VPS dispatch
        // (never guarded by an `if`). HARNESS_OC_DATA_HOME was deliberately dropped from this check
        // (#516 adversarial review): `core/opencode/skills/triaging-requests/SKILL.md` already
        // documents it as NOT a reliable headless/fleet signal — "a manually-started operator
        // session on the VPS inherits it from the shell" — so keying on it here would have armed
        // this choke-point (and its npx/node -e/bash -c/tar/source denies) against a live operator's
        // own interactive SSH session on the VPS, exactly the interactive-path friction this
        // choke-point must NOT reintroduce (see below). Mirrors the SAME scope DANGEROUS_BASH_DENYLIST's
        // own JSDoc already documents ("[#499] a DELIBERATE, NARROW exception ... scoped to this
        // one fleet-seeding function"). An unconditional (interactive-included) enforcement here
        // would re-impose exactly the over-blocking friction (npx/node -e/bash -c/tar/source on
        // ordinary local dev commands) that a separate, not-yet-executed roadmap item
        // (oc-forge-wall-removal) exists to REMOVE from the interactive path — widening this
        // choke-point to all sessions would silently contradict that already-documented design
        // intent, so it stays fleet-scoped like its source constant.
        const fleetDispatch = Boolean(process.env.HARNESS_NOTIFY_PROJECT)
        if (fleetDispatch) {
          let decideDangerousBashDenylist: ((command: string) => { allow: boolean; reason?: string }) | null = null
          try {
            ;({ decideDangerousBashDenylist } = await import(
              "../../shared/lib/dangerous-bash-denylist.mjs"
            ))
          } catch (err) {
            // The backstop module itself is unavailable (e.g. missing from an old vendor) — an
            // infra fault of this backstop, not a security decision: fail open, but LOUDLY, so a
            // silently-broken choke-point is never mistaken for "nothing to deny" (#516 adversarial
            // review — the sibling gate-state-unreadable fail-open at :387 already logs this way).
            console.error(
              `${PREFIX} denylist choke-point unavailable, allowing dispatch: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          if (decideDangerousBashDenylist) {
            const denylistDecision = decideDangerousBashDenylist(
              typeof command === "string" ? command : "",
            )
            if (!denylistDecision.allow) {
              throw new Error(
                `${PREFIX} Blocked: ${denylistDecision.reason} (fleet bash denylist choke-point, ` +
                  `independent of resolved permission.bash — issue #516).`,
              )
            }
          }
        }

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
      // problem — we cannot know whose state to check — and stays fail-closed.
      const gateStateUnreadable =
        !loaded.ok && typeof loaded.reason === "string" && loaded.reason.startsWith("gate-state")
      if (!loaded.ok && isDeliveryRole(subagentType)) {
        if (gateStateUnreadable) {
          console.error(`${PREFIX} gate-state unreadable, allowing dispatch: ${loaded.reason}`)
        } else {
          throw new Error(`${PREFIX} ${loaded.reason}`)
        }
      }
      const gateState = loaded.ok ? loaded.state : {}
      const optionalIds = extractFeatureTaskIds(toolArgs)
      const featureId = identity.featureIdSource === "runtime-envelope"
        ? identity.featureId
        : typeof gateState.feature_id === "string" ? gateState.feature_id : optionalIds.featureId
      const taskId = identity.taskId || optionalIds.taskId
      // What THIS dispatch declares as its planning target, independent of gate-state's own
      // (possibly stale) feature_id. `featureId` above always collapses to gateState.feature_id
      // once one exists, which would make decideEntryTask's planner featureMismatch check a
      // tautology (always comparing gateState.feature_id to itself); this stays independent so a
      // genuine mismatch — a planner Task declaring a DIFFERENT feature than gate-state —
      // is actually reachable.
      const dispatchFeatureId = identity.featureIdSource === "runtime-envelope"
        ? identity.featureId
        : optionalIds.featureId
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
