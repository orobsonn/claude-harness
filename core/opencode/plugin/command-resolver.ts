/** @description Trusted plugin tool for descriptor-only coordination and active-hand focused verification. */
import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import { gateStatePath } from "../../shared/lib/path-helpers.mjs"

type Authorization = { mode: "descriptor" | "execute"; runtimeSessionID: string; runtimeCallID: string; parentSessionID: string; parentCallID: string; featureID: string; taskID: string; role: string; snapshotHash: string; fingerprint: string; deniedClass: string; deniedCommand: string; registryID: string; testPath: string }

function response(payload: Record<string, unknown>) { return { title: `verify: ${String(payload.status ?? "rejected")}`, output: JSON.stringify(payload, null, 2), metadata: payload } }

export async function createCommandResolverPlugin(projectRoot: string, deps: { client?: any; resolveRuntimeIdentity?: any; runPinnedVitest?: any } = {}) {
  const { tool } = await import("@opencode-ai/plugin/tool")
  const { resolveScopeRuntimeIdentity, invalidateScopeRuntimeIdentity } = await import("./lib/scope-runtime-identity.mjs")
  const { readCanonicalTaskFromSnapshot } = await import("./lib/dispatch-scope.mjs")
  const { registeredEquivalent, selectLockedTest, denialFingerprint, runPinnedVitest } = await import("./lib/command-resolver.mjs")
  const { withGateStateLock } = await import("./lib/gate-state.mjs")
  const authorized = new WeakMap<object, Authorization>()

  function loadState(sessionID: string) {
    const ref = gateStatePath({ projectRoot, runtime: "opencode", sessionId: sessionID })
    if (!ref.ok) return { ok: false, reason: ref.reason }
    try { return { ok: true, path: ref.path, state: JSON.parse(fs.readFileSync(ref.path, "utf8")) as Record<string, any> } } catch { return { ok: false, reason: "gate-state missing or unreadable" } }
  }

  function claim(auth: Authorization, terminalIfMissing: boolean) {
    const loaded = loadState(auth.parentSessionID)
    if (!loaded.ok) return loaded
    let existing: any = null
    const persisted = withGateStateLock(loaded.path, (state: Record<string, any>) => {
      if (state.session_id !== auth.parentSessionID || state.feature_id !== auth.featureID || state.planner_status !== "usable") return { ok: false, reason: "planner/session/feature identity changed" }
      const canonical = readCanonicalTaskFromSnapshot(projectRoot, state, auth.taskID)
      if (!canonical.ok || canonical.snapshotHash !== auth.snapshotHash) return { ok: false, reason: "bound task snapshot changed before claim" }
      if (auth.mode === "execute") {
        const active = state.active_dispatch
        const sameRole = String(active?.role ?? "").replace(/-spawn$/, "") === auth.role.replace(/-spawn$/, "")
        if (!active || active.status !== "active" || active.session_id !== auth.parentSessionID || active.feature_id !== auth.featureID || active.task_id !== auth.taskID || active.call_id !== auth.parentCallID || active.snapshot_hash !== auth.snapshotHash || !sameRole) return { ok: false, reason: "active dispatch changed before claim" }
      }
      const entries = Array.isArray(state.command_resolutions) ? [...state.command_resolutions] : []
      existing = entries.find((entry: any) => entry?.fingerprint === auth.fingerprint) ?? entries.find((entry: any) => entry?.session_id === auth.parentSessionID && entry?.feature_id === auth.featureID && entry?.task_id === auth.taskID && entry?.denied_class === auth.deniedClass && entry?.status === "no_equivalent")
      if (existing) {
        if (auth.mode === "execute" && existing.status === "resolved") {
          return { ...state, command_resolutions: entries.map((entry: any) => entry?.fingerprint === auth.fingerprint ? { ...entry, status: "resolving" } : entry) }
        }
        return state
      }
      entries.push({ fingerprint: auth.fingerprint, session_id: auth.parentSessionID, feature_id: auth.featureID, task_id: auth.taskID, denied_class: auth.deniedClass, registry_id: auth.registryID || null, resolution: auth.registryID ? { tool: "verify", registry_id: auth.registryID, test_path: auth.testPath } : null, status: terminalIfMissing ? "no_equivalent" : auth.mode === "descriptor" ? "resolved" : "resolving" })
      return { ...state, command_resolutions: entries }
    })
    return persisted.ok ? { ok: true, existing } : persisted
  }

  const verify = tool({
    description: "Resolve a known denial to a closed descriptor; only its trusted active writing hand may execute local Vitest.",
    args: {
      feature_id: tool.schema.string().describe("Exact feature id from bound runtime state"),
      task_id: tool.schema.string().describe("Exact active task id"),
      denied_class: tool.schema.string().describe("Exact policy denied class, or targeted_vitest"),
      denied_command: tool.schema.string().optional().describe("Exact denied command for registered recovery"),
      test_path: tool.schema.string().describe("Exact canonical locked_tests[].path"),
    },
    async execute(args, context) {
      if (!args || typeof args !== "object") return response({ ok: false, status: "rejected", reason: "exact before-hook args required" })
      const auth = authorized.get(args)
      authorized.delete(args)
      if (!auth || auth.runtimeSessionID !== context.sessionID || auth.runtimeCallID !== (context as any).callID || auth.featureID !== args.feature_id || auth.taskID !== args.task_id || auth.deniedClass !== args.denied_class || auth.deniedCommand !== (typeof args.denied_command === "string" ? args.denied_command : "") || auth.testPath !== args.test_path) return response({ ok: false, status: "rejected", reason: "authorization missing, cloned, replayed, or mismatched" })
      const initial = claim(auth, !auth.registryID)
      if (!initial.ok) return response({ ok: false, status: "rejected", reason: initial.reason })
      if (initial.existing && !(auth.mode === "execute" && initial.existing.status === "resolved")) return response({ ok: false, ...initial.existing, status: initial.existing.status, repeated: true })
      if (!auth.registryID) return response({ ok: false, fingerprint: auth.fingerprint, denied_class: auth.deniedClass, status: "no_equivalent", resolution: null })
      const descriptor = { tool: "verify", registry_id: auth.registryID, test_path: auth.testPath }
      if (auth.mode === "descriptor") return response({ ok: true, fingerprint: auth.fingerprint, status: "resolved", descriptor })
      const run = (deps.runPinnedVitest ?? runPinnedVitest)(projectRoot, auth.testPath)
      const loaded = loadState(auth.parentSessionID)
      if (!loaded.ok) return response({ ok: false, status: "rejected", reason: loaded.reason })
      let immutableConflict = false
      const saved = withGateStateLock(loaded.path, (state: Record<string, any>) => {
        const entries = Array.isArray(state.command_resolutions) ? state.command_resolutions : []
        const current = entries.find((entry: any) => entry?.fingerprint === auth.fingerprint)
        if (!current || current.status !== "resolving") { immutableConflict = true; return state }
        return { ...state, command_resolutions: entries.map((entry: any) => entry?.fingerprint === auth.fingerprint ? { ...entry, status: run.status } : entry) }
      })
      if (!saved.ok || immutableConflict) return response({ ok: false, status: "rejected", reason: saved.ok ? "terminal resolution is immutable" : saved.reason })
      return response({ ...run, fingerprint: auth.fingerprint, denied_class: auth.deniedClass, resolution: descriptor })
    },
  })

  return {
    tool: { verify },
    "tool.execute.before": async (input: any, output: any) => {
      if (input?.tool !== "verify") return
      const args = output?.args
      if (!args || typeof args !== "object" || Array.isArray(args) || authorized.has(args)) throw new Error("[command-resolver] exact fresh args object required")
      if (typeof args.feature_id !== "string" || typeof args.task_id !== "string" || typeof args.denied_class !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(args.denied_class) || typeof args.test_path !== "string") throw new Error("[command-resolver] exact feature/task/denied_class/test_path strings required")
      const runtimeSessionID = typeof input.sessionID === "string" ? input.sessionID : ""
      const runtimeCallID = typeof input.callID === "string" ? input.callID : ""
      if (!runtimeSessionID || !runtimeCallID) throw new Error("[command-resolver] runtime session/call required")
      const resolveIdentity = deps.resolveRuntimeIdentity ?? resolveScopeRuntimeIdentity
      const trusted = await resolveIdentity(projectRoot, input, { client: deps.client })
      const parentSessionID = trusted.ok ? trusted.parentSessionId : trusted.notWritingSession === true ? trusted.runtimeSessionId : ""
      if (!parentSessionID) throw new Error(`[command-resolver] trusted runtime identity rejected (${trusted.reason})`)
      const loaded = loadState(parentSessionID)
      if (!loaded.ok) throw new Error(`[command-resolver] ${loaded.reason}`)
      const state = loaded.state
      if (state.session_id !== parentSessionID || state.feature_id !== args.feature_id || state.planner_status !== "usable") throw new Error("[command-resolver] exact usable session/feature planner binding required")
      const canonical = readCanonicalTaskFromSnapshot(projectRoot, state, args.task_id)
      if (!canonical.ok) throw new Error(`[command-resolver] ${canonical.reason}`)
      const selected = selectLockedTest(canonical.task, args.test_path, projectRoot)
      if (!selected.ok) throw new Error(`[command-resolver] ${selected.reason}`)
      const equivalent = registeredEquivalent(args.denied_class, args.denied_command, selected.test_path)
      const mode = trusted.ok ? "execute" : "descriptor"
      if (mode === "execute") {
        const active = state.active_dispatch
        const sameRole = String(active?.role ?? "").replace(/-spawn$/, "") === String(trusted.role).replace(/-spawn$/, "")
        if (!active || active.status !== "active" || active.session_id !== parentSessionID || active.feature_id !== state.feature_id || active.task_id !== canonical.task.id || active.call_id !== trusted.callId || active.snapshot_hash !== canonical.snapshotHash || !sameRole) throw new Error("[command-resolver] active dispatch call/task/role/snapshot mismatch")
      }
      const registryID = equivalent?.registry_id ?? ""
      authorized.set(args, { mode, runtimeSessionID, runtimeCallID, parentSessionID, parentCallID: trusted.ok ? trusted.callId : "", featureID: state.feature_id, taskID: canonical.task.id, role: trusted.ok ? trusted.role : "coordinator", snapshotHash: canonical.snapshotHash, fingerprint: denialFingerprint({ sessionId: parentSessionID, featureId: state.feature_id, taskId: canonical.task.id, deniedClass: args.denied_class, registryId: registryID, testPath: selected.test_path }), deniedClass: args.denied_class, deniedCommand: typeof args.denied_command === "string" ? args.denied_command : "", registryID, testPath: selected.test_path })
    },
    "tool.execute.after": async (input: any) => { if (input?.tool === "verify") invalidateScopeRuntimeIdentity(projectRoot, input?.sessionID, input?.callID) },
  }
}

const CommandResolver: Plugin = async ({ directory, worktree, client }: any) => createCommandResolverPlugin(typeof directory === "string" && directory ? directory : worktree, { client })
export default CommandResolver
