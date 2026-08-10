/**
 * @description OC entry-gate plugin — plain persisted planner facts + bash delivery/forge.
 * On tool.execute.before:
 * - bash/shell: decideBashAdvisory (allow + advisory, never denies) then decideBashDelivery
 *   (gate-state from disk via lib/gate-state.mjs)
 * - task: decideEntryTask for factual delivery, re-gate, fidelity, and planner rails.
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
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

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
  /** Session environment carrying host-frozen fix-mode authority (injectable in tests). */
  dispatchEnvironment?: Record<string, string | undefined>
  listHandRecordsForFeatureFn?: (featureId: string) => unknown[]
  /** Read the exact PR's GitHub check rollup immediately before `gh pr merge`. */
  readMergeCheckRollupFn?: (target: string | null) => unknown
  /** Whether the current branch is a mechanically verified lifecycle-only change. */
  isLifecycleOnlyMergeFn?: () => boolean
  /** Resolve parent session id for classify top-level rail (injectable in tests). */
  getSessionParentIdFn?: (sessionId: string) => Promise<string | null>
  /** Acting agent name when known (injectable). */
  resolveActingAgentFn?: (input: unknown, output: unknown) => string | null
  /** Resolve exact official caller facts for the sensitive routing tool (injectable). */
  resolveConfigureRoutingAuthorityFn?: (input: {
    sessionId: string
    callId: string
    toolName: string
  }) => Promise<{ ok: boolean; reason?: string; agent?: unknown; parentSessionId?: unknown }>
  /** Official SDK client used only to bind factual child Task metadata. */
  client?: any
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

/** @description Native routing tool — lifecycle lane only. */
function isConfigureRoutingTool(toolName: unknown): boolean {
  if (typeof toolName !== "string") return false
  const n = toolName.toLowerCase()
  return n === "configure-routing" || n.endsWith("_configure-routing") || n.endsWith(".configure-routing")
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
function defaultIsAncestor(sha: string, cwd = process.cwd()): boolean | null {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd,
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

/** @description One direct GitHub read; unavailable evidence is denied by the shared policy. */
function defaultMergeCheckRollup(target: string | null, cwd: string): unknown {
  try {
    const output = execFileSync(
      "gh",
      ["pr", "view", ...(target === null ? [] : [target]), "--json", "statusCheckRollup"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 },
    )
    return JSON.parse(output)?.statusCheckRollup
  } catch {
    return null
  }
}

/**
 * @description A lifecycle update is allowed to merge without CI only when its current branch
 * is the helper's exact branch shape and every committed path is listed by its vendor manifest.
 * This preserves the normal CI rail for product PRs and fails closed on any git/manifest doubt.
 */
function defaultIsLifecycleOnlyMerge(cwd: string): boolean {
  try {
    const git = (args: string[]) => execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const branch = git(["branch", "--show-current"])
    if (!/^chore\/harness-lifecycle-(updating-harness|configuring-model-routing)-\d+$/.test(branch)) {
      return false
    }

    const owned = new Set<string>()
    for (const relativePath of [
      ".opencode/.harness-owned-files.json",
      ".claude/.harness-owned-files.json",
    ]) {
      const manifestPath = join(cwd, relativePath)
      if (!existsSync(manifestPath)) continue
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      if (
        manifest?.version !== 1 ||
        !Array.isArray(manifest.files) ||
        manifest.files.some((file: unknown) =>
          typeof file !== "string" ||
          file.length === 0 ||
          file.startsWith("/") ||
          file.split("/").includes(".."),
        )
      ) {
        return false
      }
      for (const file of manifest.files) owned.add(file)
    }
    if (owned.size === 0) return false

    const remoteHead = git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"])
    if (!/^origin\/(main|master)$/.test(remoteHead)) return false
    const changed = execFileSync(
      "git",
      ["diff", "--name-only", "-z", `${remoteHead}...HEAD`],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).split("\0").filter(Boolean)
    return changed.length > 0 && changed.every((file) => owned.has(file))
  } catch {
    return false
  }
}

/**
 * @description Builds entry-gate hooks (async load of pure decide mjs).
 * Optional deps override git/list/ancestor seams for tests.
 */
async function createEntryGateHooks(
  projectRoot: string,
  deps: EntryGateDeps = {},
): Promise<Pick<Hooks, "tool.execute.before" | "tool.execute.after" | "event">> {
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
  const { isExecutorRole, isSniperRole, isTestAuthorRole } = await import("../lib/roles.mjs")
  const { claimDispatchForRuntime, bindChildSession, removeDispatchRecord } = await import("../lib/dispatch-scope.mjs")
  const { recordTaskCompletion } = await import("./lib/host-hand-capture.mjs")
  const { computeGitState } = await import("../../shared/lib/git-state.mjs")
  const { decideMergeChecks, isGhPrMergeCommand, mergeTargetFromCommand } = await import("../../shared/lib/merge-check-gate.mjs")
  const { listHandRecordsForFeature } = await import("../lib/hand-records.mjs")

  const gitStateFn =
    deps.gitStateFn ?? (() => defaultGitState(computeGitState))
  const isAncestorFn = deps.isAncestorFn ?? ((sha: string) => defaultIsAncestor(sha, root))
  const dispatchEnvironment = deps.dispatchEnvironment ?? process.env
  const listHandRecordsForFeatureFn =
    deps.listHandRecordsForFeatureFn ??
    ((featureId: string) => listHandRecordsForFeature(root, featureId))
  const readMergeCheckRollupFn =
    deps.readMergeCheckRollupFn ?? ((target: string | null) => defaultMergeCheckRollup(target, root))
  const isLifecycleOnlyMergeFn =
    deps.isLifecycleOnlyMergeFn ?? (() => defaultIsLifecycleOnlyMerge(root))
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
  const resolveConfigureRoutingAuthorityFn =
    deps.resolveConfigureRoutingAuthorityFn ??
    (async ({ sessionId, callId, toolName }: { sessionId: string; callId: string; toolName: string }) => {
      if (!sessionId || !callId || typeof client?.session?.get !== "function" || typeof client?.session?.messages !== "function") {
        return { ok: false, reason: "official runtime metadata unavailable" }
      }
      try {
        const unwrap = (value: any) => value && typeof value === "object" && "data" in value ? value.data : value
        const session = unwrap(await client.session.get({ path: { id: sessionId }, query: { directory: root } }))
        if (!session || session.id !== sessionId) return { ok: false, reason: "official session identity conflicts" }
        const messages = unwrap(await client.session.messages({ path: { id: sessionId }, query: { directory: root } }))
        const matches: Array<{ info: any; part: any }> = []
        for (const bundle of Array.isArray(messages) ? messages : []) {
          for (const part of Array.isArray(bundle?.parts) ? bundle.parts : []) {
            if (part?.type === "tool" && part.callID === callId) matches.push({ info: bundle?.info, part })
          }
        }
        if (matches.length !== 1) return { ok: false, reason: "official tool call identity must match exactly one part" }
        const { info, part } = matches[0]
        const agent = typeof info?.agent === "string" ? info.agent : info?.mode
        if (
          info?.role !== "assistant" ||
          info?.sessionID !== sessionId ||
          part?.sessionID !== sessionId ||
          part?.messageID !== info?.id ||
          String(part?.tool).toLowerCase() !== toolName.toLowerCase() ||
          typeof agent !== "string" || !agent.trim()
        ) {
          return { ok: false, reason: "official tool/session metadata conflicts" }
        }
        const parent = typeof session.parentID === "string" ? session.parentID.trim() : ""
        return { ok: true, agent, parentSessionId: parent || null }
      } catch {
        return { ok: false, reason: "official runtime metadata unavailable" }
      }
    })

  const writingHand = (role: unknown) => isExecutorRole(role) || isSniperRole(role) || isTestAuthorRole(role)
  const client = deps.client

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

      // configure-routing changes who judges every later delivery. Its confirmation is the
      // host-owned `permission: ask` rule; this belt refuses any caller other than the exact
      // official, root lifecycle lane, independently of model-supplied tool arguments.
      if (isConfigureRoutingTool(toolName)) {
        const authority = await resolveConfigureRoutingAuthorityFn({
          sessionId: typeof sessionId === "string" ? sessionId : "",
          callId: typeof input?.callID === "string" ? input.callID : typeof input?.callId === "string" ? input.callId : "",
          toolName: typeof toolName === "string" ? toolName : "",
        })
        if (!authority?.ok) throw new Error(`${PREFIX} configure-routing denied: ${authority?.reason ?? "official runtime metadata unavailable"}`)
        const parent = typeof authority.parentSessionId === "string" ? authority.parentSessionId.trim() : ""
        if (parent) throw new Error(`${PREFIX} configure-routing denied on child session — only the root harness-config lane may change routing`)
        const agent = typeof authority.agent === "string" ? authority.agent.trim().toLowerCase().replace(/\.md$/, "") : ""
        if (agent !== "harness-config") throw new Error(`${PREFIX} configure-routing denied for agent '${typeof authority.agent === "string" ? authority.agent : "unknown"}' — only harness-config may change routing`)
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

        // `gh pr merge` is the one delivery verb that needs external evidence. Resolve the
        // literal target without evaluating shell syntax, read it once, and fail closed on any
        // missing/pending/red/unknown rollup. Other delivery gates remain pure and local.
        if (isGhPrMergeCommand(command)) {
          const target = mergeTargetFromCommand(command)
          const checkDecision = target === undefined
            ? { ok: false, reason: "PR target is ambiguous; merge is denied." }
            : decideMergeChecks(readMergeCheckRollupFn(target))
          const allowsLifecycleWithoutCi =
            target === null &&
            checkDecision.ok === false &&
            "state" in checkDecision &&
            checkDecision.state === "missing" &&
            isLifecycleOnlyMergeFn()
          if (!checkDecision.ok && !allowsLifecycleWithoutCi) {
            throw new Error(`${PREFIX} Blocked: ${checkDecision.reason}`)
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
          isAncestorFn,
        }),
      )
      if (writingHand(subagentType)) {
        const callId = typeof input?.callID === "string" ? input.callID : typeof input?.callId === "string" ? input.callId : ""
        if (!sid || !callId || !taskId) {
          if (dispatchEnvironment.HARNESS_FIX_MODE === "1") throw new Error(`${PREFIX} exact dispatch identity required in fix mode`)
          return
        }
        const claimed = claimDispatchForRuntime(root, {
          sessionId: sid,
          callId,
          role: subagentType,
          taskId,
          featureId,
        }, { env: dispatchEnvironment, isAncestorFn })
        if (!claimed.ok) throw new Error(`${PREFIX} exact dispatch record rejected: ${claimed.reason}`)
      }
    },
    "tool.execute.after": async (input: any, output: any) => {
      let sessionId = ""
      let callId = ""
      let cleanupExactRecord = false
      try {
        const { toolName, toolArgs, subagentType } = extractHookTaskContext(input, output)
        if (!isTaskTool(toolName) || !writingHand(subagentType)) return
        sessionId = typeof input?.sessionID === "string" ? input.sessionID : ""
        callId = typeof input?.callID === "string" ? input.callID : ""
        const prompt = toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs) ? (toolArgs as Record<string, unknown>).prompt : undefined
        const promptMarker = parseTaskDispatchIdentity(prompt)
        const identity = resolveHookIdentity({ input, toolArgs, promptTaskId: promptMarker.ok ? promptMarker.taskId : "" })
        if (!identity.ok || !sessionId || !callId) return
        const loaded = loadGateStateFromDisk(root, { sessionId })
        const optionalIds = extractFeatureTaskIds(toolArgs)
        const featureId = identity.featureIdSource === "runtime-envelope"
          ? identity.featureId
          : loaded.ok && typeof loaded.state?.feature_id === "string" ? loaded.state.feature_id : optionalIds.featureId
        const taskId = identity.taskId || optionalIds.taskId
        if (featureId && taskId) {
          const completion = recordTaskCompletion({
          projectRoot: root,
          sessionId,
          featureId,
          taskId,
          role: subagentType,
          producerCallId: callId,
          outputText: String(output?.output ?? output?.content ?? output?.result ?? ""),
          background: output?.metadata?.background === true,
          })
          cleanupExactRecord = completion.ok === true && completion.terminal === true && completion.capturePending !== true
        }
      } catch { /* terminal completion observation is best-effort */ }
      finally {
        if (cleanupExactRecord && sessionId && callId) removeDispatchRecord(root, { sessionId, callId })
      }
    },
    event: async ({ event }: any) => {
      try {
        if (event?.type === "message.part.updated") {
          const part = event?.properties?.part ?? event?.part
          if (part?.type === "tool" && isTaskTool(part?.tool) && part?.state?.status === "error" && typeof part?.sessionID === "string" && typeof part?.callID === "string") {
            removeDispatchRecord(root, { sessionId: part.sessionID, callId: part.callID })
            return
          }
        }
        if (event?.type !== "message.updated" || typeof client?.session?.get !== "function" || typeof client?.session?.messages !== "function") return
        const info = event?.properties?.info
        const childSessionId = typeof info?.sessionID === "string" ? info.sessionID : ""
        if (!childSessionId || !writingHand(info?.agent)) return
        const sessionResult = await client.session.get({ path: { id: childSessionId }, query: { directory: root } })
        const session = sessionResult && typeof sessionResult === "object" && "data" in sessionResult ? (sessionResult as any).data : sessionResult
        if (session?.id !== childSessionId) return
        const parentSessionId = typeof session?.parentID === "string" ? session.parentID : ""
        if (!parentSessionId) return
        const messagesResult = await client.session.messages({ path: { id: parentSessionId }, query: { directory: root } })
        const messages = messagesResult && typeof messagesResult === "object" && "data" in messagesResult ? (messagesResult as any).data : messagesResult
        const matches: Array<{ callId: string, role: string }> = []
        for (const bundle of Array.isArray(messages) ? messages : []) {
          for (const part of Array.isArray(bundle?.parts) ? bundle.parts : []) {
            const role = part?.state?.input?.subagent_type
            if (bundle?.info?.role === "assistant" && bundle?.info?.sessionID === parentSessionId && part?.type === "tool" && isTaskTool(part?.tool) && part?.sessionID === parentSessionId && part?.messageID === bundle?.info?.id && part?.state?.status === "running" && part?.state?.metadata?.sessionId === childSessionId && typeof part?.callID === "string" && writingHand(role)) matches.push({ callId: part.callID, role })
          }
        }
        if (matches.length !== 1) return
        bindChildSession(root, { parentSessionId, childSessionId, role: matches[0].role, callId: matches[0].callId })
      } catch { /* SDK faults leave scope unavailable; plan-write opens diagnostically */ }
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
  return createEntryGateHooks(root, { getSessionParentIdFn, client })
}
Object.defineProperty(EntryGate, "testApi", { value: Object.freeze({ createEntryGateHooks }) })

export default EntryGate
