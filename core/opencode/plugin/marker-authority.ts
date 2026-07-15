/**
 * @description Runtime marker tool and its before-hook share one private args-identity authority.
 * Threat boundary: prevents model Bash/import/replay/clone paths enforced by this harness. It does
 * not protect against a compromised OpenCode host/plugin or arbitrary same-user filesystem writes.
 */

import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { withGateStateLock } from "./lib/gate-state.mjs"
import { mergeGateStatePatch, dualStatusGatePatch } from "../../shared/lib/gate-state-shape.mjs"
import { gateStatePath, handRecordPath } from "../../shared/lib/path-helpers.mjs"
import { isDoneHandRecord } from "../../shared/lib/real-file-capture-rail.mjs"
import { captureSpecAdversaryResult, transitionCeremony } from "./lib/ceremony-transition.mjs"
import { fidelityPassEntry, defaultHeadSha } from "./lib/mark-gate.mjs"
import { sealedMarkerRecord } from "./lib/marker-seal.mjs"

type MarkerArgs = {
  action?: string
  task_id?: string
  status?: string
  sha?: string
  feature_id?: string
}

type Authorization = {
  sessionID: string
  callID: string
  featureID: string
  action: string
}

const ACTIONS = new Set([
  "brainstormed",
  "adversary_fired",
  "fidelity",
  "dual",
  "regate-pending",
  "regate-passed",
  "hand-finished",
  "capture-verified",
])

function response(ok: boolean, reason = "", metadata: Record<string, unknown> = {}) {
  const body = { ok, ...(reason ? { reason } : {}), ...metadata }
  return { title: ok ? "mark: persisted" : "mark: rejected", output: JSON.stringify(body, null, 2), metadata: body }
}

function atomicJsonWrite(file: string, value: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8")
    fs.renameSync(temporary, file)
    return true
  } catch {
    try { fs.rmSync(temporary, { force: true }) } catch { /* ignore */ }
    return false
  }
}

const MarkerAuthority: Plugin = async ({ directory, worktree }) => {
  const { tool } = await import("@opencode-ai/plugin/tool")
  const projectRoot = typeof directory === "string" && directory ? directory : worktree
  const authorizedArgs = new WeakMap<object, Authorization>()

  function mutate(args: MarkerArgs, authorization: Authorization) {
    const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId: authorization.sessionID })
    if (!statePath.ok) return { ok: false, reason: statePath.reason }
    return withGateStateLock(statePath.path, (previous: Record<string, unknown>) => {
      if (previous.session_id !== authorization.sessionID || previous.feature_id !== authorization.featureID) {
        return { ok: false, reason: "gate-state identity changed before marker mutation" }
      }
      const action = authorization.action
      let patch: Record<string, unknown>
      let payload: unknown
      if (action === "brainstormed" || action === "adversary_fired") {
        const transitioned = transitionCeremony(projectRoot, previous, action)
        if (!transitioned.ok) return transitioned
        return transitioned.state
      } else if (action === "dual") {
        const dual = dualStatusGatePatch(args.status)
        if ("ok" in dual && dual.ok === false) return dual
        patch = dual as Record<string, unknown>
        payload = args.status
      } else {
        const taskId = typeof args.task_id === "string" ? args.task_id : ""
        if (!taskId) return { ok: false, reason: `${action} requires task_id` }
        const bare = fidelityPassEntry(authorization.featureID, taskId, null)
        if (action === "fidelity") {
          const sha = typeof args.sha === "string" && args.sha ? args.sha : defaultHeadSha(projectRoot)
          payload = fidelityPassEntry(authorization.featureID, taskId, sha)
          patch = { fidelity_pass: [payload] }
        } else if (action === "regate-pending") {
          payload = bare
          patch = { regate_pending: [bare] }
        } else if (action === "hand-finished") {
          payload = bare
          patch = { hand_finished: [bare] }
        }
        else if (action === "regate-passed") {
          const sha = typeof args.sha === "string" && args.sha ? args.sha : defaultHeadSha(projectRoot)
          if (!sha) return { ok: false, reason: "regate-passed requires a resolved commit SHA" }
          payload = fidelityPassEntry(authorization.featureID, taskId, sha)
          patch = { regate_passed: [payload] }
        } else if (action === "capture-verified") {
          const sha = typeof args.sha === "string" && args.sha ? args.sha : defaultHeadSha(projectRoot)
          if (!sha) return { ok: false, reason: "capture-verified requires a resolved commit SHA" }
          if (!Array.isArray(previous.hand_finished) || !previous.hand_finished.includes(bare)) {
            return { ok: false, reason: "hand_finished does not contain feature/task" }
          }
          const recordPath = handRecordPath(
            { projectRoot, runtime: "opencode", sessionId: authorization.sessionID, featureId: authorization.featureID },
            taskId,
          )
          if (!recordPath.ok) return { ok: false, reason: recordPath.reason }
          let record: Record<string, unknown>
          try { record = JSON.parse(fs.readFileSync(recordPath.path, "utf8")) } catch {
            return { ok: false, reason: "hand-record missing or unreadable" }
          }
          if (!isDoneHandRecord(record)) return { ok: false, reason: "hand-record is not DONE" }
          if (!atomicJsonWrite(recordPath.path, { ...record, capturedVerifiedAt: new Date().toISOString() })) {
            return { ok: false, reason: "hand-record persistence failed" }
          }
          payload = fidelityPassEntry(authorization.featureID, taskId, sha)
          patch = { capture_verified: [payload] }
        } else return { ok: false, reason: "unknown privileged marker action" }
      }
      const applied = mergeGateStatePatch(previous, patch)
      if (!applied.ok) return applied
      const record = sealedMarkerRecord({
        sessionId: authorization.sessionID,
        featureId: authorization.featureID,
        operation: action,
        payload,
      })
      const prior = Array.isArray(previous.marker_seals) ? previous.marker_seals : []
      applied.state.marker_seals = [
        ...prior.filter((candidate: any) => !(
          candidate?.operation === action &&
          candidate?.session_id === authorization.sessionID &&
          candidate?.feature_id === authorization.featureID &&
          JSON.stringify(candidate?.payload) === JSON.stringify(payload)
        )),
        record,
      ]
      return applied.state
    })
  }

  const mark = tool({
    description: "Persist a runtime-bound privileged harness marker. Bash is observability-only.",
    args: {
      action: tool.schema.string().describe("brainstormed | adversary_fired | fidelity | dual | regate-pending | regate-passed | hand-finished | capture-verified"),
      task_id: tool.schema.string().optional().describe("Task id for task-scoped markers"),
      status: tool.schema.string().optional().describe("dual_status value for the dual marker"),
      sha: tool.schema.string().optional().describe("Commit SHA for SHA-qualified markers"),
      feature_id: tool.schema.string().optional().describe("Untrusted hint; classified runtime identity wins"),
    },
    async execute(args, context) {
      if (!args || typeof args !== "object") return response(false, "exact before-hook args identity required")
      const authorization = authorizedArgs.get(args)
      authorizedArgs.delete(args)
      const callID = (context as unknown as { callID?: unknown }).callID
      if (
        !authorization ||
        authorization.sessionID !== context.sessionID ||
        authorization.callID !== callID ||
        authorization.action !== args.action
      ) return response(false, "marker authorization missing, cloned, replayed, or binding-mismatched")
      const result = mutate(args, authorization)
      if (!result.ok) return response(false, String(result.reason ?? "marker failed"))
      return response(true, "", {
        action: authorization.action,
        session_id: authorization.sessionID,
        feature_id: authorization.featureID,
      })
    },
  })

  return {
    tool: { mark },
    "tool.execute.before": async (input: any, output: any) => {
      if (input?.tool !== "mark") return
      const args = output?.args
      if (!args || typeof args !== "object" || Array.isArray(args)) {
        throw new Error("[marker-authority] exact object args required")
      }
      if (authorizedArgs.has(args)) throw new Error("[marker-authority] args object already authorized")
      const action = typeof args.action === "string" ? args.action : ""
      if (!ACTIONS.has(action)) throw new Error("[marker-authority] unknown privileged marker action")
      const sessionID = typeof input.sessionID === "string" ? input.sessionID : ""
      const callID = typeof input.callID === "string" ? input.callID : ""
      if (!sessionID || !callID) throw new Error("[marker-authority] runtime sessionID and callID required")
      const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId: sessionID })
      if (!statePath.ok) throw new Error(`[marker-authority] ${statePath.reason}`)
      let state: Record<string, unknown>
      try { state = JSON.parse(fs.readFileSync(statePath.path, "utf8")) } catch {
        throw new Error("[marker-authority] gate-state missing or unreadable")
      }
      const featureID = typeof state.feature_id === "string" ? state.feature_id : ""
      if (!featureID || state.session_id !== sessionID) {
        throw new Error("[marker-authority] classified runtime identity required")
      }
      authorizedArgs.set(args, { sessionID, callID, featureID, action })
    },
    "tool.execute.after": async (input: any, output: any) => {
      const args = output?.args ?? input?.args
      const role = args && typeof args === "object" ? args.subagent_type ?? args.subagentType : ""
      if (input?.tool !== "task" || role !== "adversary-family-1") return
      const sessionID = typeof input.sessionID === "string" ? input.sessionID : ""
      const callID = typeof input.callID === "string" ? input.callID : ""
      const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId: sessionID })
      if (!statePath.ok) return
      let state: Record<string, unknown>
      try { state = JSON.parse(fs.readFileSync(statePath.path, "utf8")) } catch { return }
      if ((state.planner_status && state.planner_status !== "not_started") || state.session_id !== sessionID || typeof state.feature_id !== "string" || typeof state.ceremony_generation !== "string") return
      captureSpecAdversaryResult(projectRoot, {
        sessionId: sessionID,
        featureId: state.feature_id,
        generation: state.ceremony_generation,
        callId: callID,
        role,
        output: output?.output ?? output?.content ?? output?.result ?? "",
      })
    },
  }
}

export default MarkerAuthority
