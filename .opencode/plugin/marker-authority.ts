/**
 * @description Runtime marker tool and its before-hook share one private args-identity authority.
 * Threat boundary: WeakMap identity and ordering protect only the native mark invocation, blocking
 * direct execute, clones, replay, concurrent reuse, and runtime-binding mismatches before mutation.
 * Persisted booleans are plain workflow state, not provenance or OS isolation. A same-user process
 * can import and instantiate its own authority or write state directly; a compromised host/plugin
 * can do the same. Those capabilities are outside this boundary.
 */

import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { withGateStateLock } from "../lib/gate-state.mjs"
import { mergeGateStatePatch } from "../shared/lib/gate-state-shape.mjs"
import { gateStatePath, handRecordPath } from "../shared/lib/path-helpers.mjs"
import { isCaptureEligibleHandRecord, recordViolations } from "../shared/lib/real-file-capture-rail.mjs"
import { formatFeatureTaskEntry } from "../shared/lib/absolution.mjs"
import { isSafeFeatureId, isSafeTaskId } from "../shared/lib/feature-id.mjs"
import { validateOcCaptureEligibleHandRecord } from "../lib/hand-records.mjs"
import { readDispatchRecord, removeDispatchRecord } from "../lib/dispatch-scope.mjs"
import { isAncestorSha, resolveHeadSha } from "./lib/host-hand-capture.mjs"

type MarkerArgs = {
  action?: string
  task_id?: string
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
  "regate-pending",
  "regate-passed",
  "hand-finished",
  "capture-verified",
  "final-review",
  "demo-done",
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

  function validateExactProducer(record: Record<string, unknown>, authorization: Authorization, taskId: string, sha?: string) {
    const identity = validateOcCaptureEligibleHandRecord(record, {
      featureId: authorization.featureID,
      taskId,
      sessionId: authorization.sessionID,
      ...(typeof sha === "string" ? { sha } : {}),
    })
    if (!identity.ok) return identity
    const producerCallId = typeof record.producerCallId === "string" ? record.producerCallId : ""
    const producer = readDispatchRecord(projectRoot, {
      parentSessionId: authorization.sessionID,
      callId: producerCallId,
    })
    if (!producer.ok) return { ok: false as const, reason: "exact producer dispatch record required" }
    if (
      producer.record.feature_id !== authorization.featureID ||
      producer.record.task_id !== taskId ||
      producer.record.role !== record.agent
    ) return { ok: false as const, reason: "producer dispatch identity mismatch" }
    return validateOcCaptureEligibleHandRecord(record, {
      featureId: authorization.featureID,
      taskId,
      sessionId: authorization.sessionID,
      producerCallId: producer.record.dispatch_call_id,
      ...(typeof sha === "string" ? { sha } : {}),
    })
  }

  function mutate(args: MarkerArgs, authorization: Authorization) {
    const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId: authorization.sessionID })
    if (!statePath.ok) return { ok: false, reason: statePath.reason }
    let capturedProducerCallId = ""
    const locked = withGateStateLock(statePath.path, (previous: Record<string, unknown>) => {
      if (previous.session_id !== authorization.sessionID || previous.feature_id !== authorization.featureID) {
        return { ok: false, reason: "gate-state identity changed before marker mutation" }
      }
      const action = authorization.action
      let patch: Record<string, unknown>
      let payload: unknown
      if (action === "brainstormed") {
        patch = { brainstormed: true }
      } else if (action === "adversary_fired") {
        if (previous.brainstormed !== true) {
          return { ok: false, reason: "adversary_fired requires brainstormed first" }
        }
        patch = { adversary_fired: true }
      } else if (action === "final-review" || action === "demo-done") {
        // Feature-scoped ship preconditions (#385) — no task_id; boolean on gate-state.
        const field = action === "final-review" ? "final_review_done" : "demo_done"
        patch = { [field]: true }
      } else {
        if (!isSafeTaskId(args.task_id)) {
          return { ok: false, reason: `${action} requires a safe task_id` }
        }
        const taskId = args.task_id
        const bare = formatFeatureTaskEntry(authorization.featureID, taskId)
        if (action === "fidelity") {
          const sha = typeof args.sha === "string" && args.sha ? args.sha : resolveHeadSha(projectRoot)
          payload = formatFeatureTaskEntry(authorization.featureID, taskId, sha)
          patch = { fidelity_pass: [payload] }
        } else if (action === "regate-pending") {
          patch = { regate_pending: [bare] }
        } else if (action === "hand-finished") {
          // Require a host-written capture-eligible record — prose mark alone must not unlock ship rails.
          const hfPath = handRecordPath(
            { projectRoot, runtime: "opencode", sessionId: authorization.sessionID, featureId: authorization.featureID },
            taskId,
          )
          if (!hfPath.ok) return { ok: false, reason: hfPath.reason }
          let hfRecord: Record<string, unknown>
          try {
            hfRecord = JSON.parse(fs.readFileSync(hfPath.path, "utf8"))
          } catch {
            return { ok: false, reason: "hand-record missing or unreadable" }
          }
          if (!isCaptureEligibleHandRecord(hfRecord)) return { ok: false, reason: "hand-record is not capture-eligible" }
          const hfIdentity = validateExactProducer(hfRecord, authorization, taskId)
          if (!hfIdentity.ok) return hfIdentity
          patch = { hand_finished: [bare] }
        }
        else if (action === "regate-passed") {
          const sha = typeof args.sha === "string" && args.sha ? args.sha : resolveHeadSha(projectRoot)
          if (!sha) return { ok: false, reason: "regate-passed requires a resolved commit SHA" }
          if (!Array.isArray(previous.regate_pending) || !previous.regate_pending.includes(bare)) {
            return { ok: false, reason: "regate_pending does not contain feature/task" }
          }
          payload = formatFeatureTaskEntry(authorization.featureID, taskId, sha)
          patch = { regate_passed: [payload] }
        } else if (action === "capture-verified") {
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
          if (!isCaptureEligibleHandRecord(record)) return { ok: false, reason: "hand-record is not capture-eligible" }
          const violations = recordViolations(record)
          if (violations.scope.length > 0 || violations.frozen.length > 0) {
            return { ok: false, reason: "hand-record contains scope or frozen violations" }
          }
          // The host-written record — not HEAD at stamp time — is the SHA authority. Anchoring on
          // HEAD made the stamp a race: any commit landing between the hand finishing and the
          // marker firing invalidated the record permanently (HEAD never rewinds), and the only
          // escape was re-dispatching a no-op hand to mint a record carrying the newer HEAD.
          // Lineage is what the absolution rail actually needs, and isAncestorSha below asserts it.
          // `args.sha` is deliberately ignored: the model can no longer choose which commit a
          // capture certifies.
          const sha = typeof record.freezeCommitSha === "string" ? record.freezeCommitSha : ""
          if (!sha) return { ok: false, reason: "capture-verified requires a resolved commit SHA" }
          payload = formatFeatureTaskEntry(authorization.featureID, taskId, sha)
          // Replay is a property of the RECORD (already stamped), never of the payload string.
          // A later hand on the same task rewrites the record from scratch and drops
          // `capturedVerifiedAt`, yet keeps the same freeze SHA — so a payload-keyed test would
          // route that brand-new producer into the replay branch, which never validates it.
          const alreadyStamped =
            typeof record.capturedVerifiedAt === "string" && record.capturedVerifiedAt.length > 0
          if (
            alreadyStamped &&
            Array.isArray(previous.capture_verified) &&
            previous.capture_verified.includes(payload)
          ) {
            const replayIdentity = validateOcCaptureEligibleHandRecord(record, {
              featureId: authorization.featureID,
              taskId,
              sessionId: authorization.sessionID,
              sha,
            })
            if (!replayIdentity.ok) return replayIdentity
            if (isAncestorSha(projectRoot, sha) !== true) {
              return { ok: false, reason: "capture-verified requires the matching record SHA to be ancestral to HEAD" }
            }
            capturedProducerCallId = String(record.producerCallId)
            return previous
          }
          const identity = validateExactProducer(record, authorization, taskId, sha)
          if (!identity.ok) return identity
          if (isAncestorSha(projectRoot, sha) !== true) {
            return { ok: false, reason: "capture-verified requires the matching record SHA to be ancestral to HEAD" }
          }
          if (!atomicJsonWrite(recordPath.path, { ...record, capturedVerifiedAt: new Date().toISOString() })) {
            return { ok: false, reason: "hand-record persistence failed" }
          }
          capturedProducerCallId = String(record.producerCallId)
          patch = { capture_verified: [payload] }
        } else return { ok: false, reason: "unknown privileged marker action" }
      }
      const applied = mergeGateStatePatch(previous, patch)
      if (!applied.ok) return applied
      return applied.state
    })
    if (!locked.ok || !capturedProducerCallId) return locked
    const removed = removeDispatchRecord(projectRoot, {
      sessionId: authorization.sessionID,
      callId: capturedProducerCallId,
    })
    if (!removed.ok) return { ok: false, reason: removed.reason }
    return locked
  }

  const mark = tool({
    description: "Persist a runtime-bound privileged harness marker. No dedicated shell CLI exists; same-user import and instantiation are outside this authority boundary.",
    args: {
      action: tool.schema.string().describe("brainstormed | adversary_fired | fidelity | regate-pending | regate-passed | hand-finished | capture-verified | final-review | demo-done"),
      task_id: tool.schema.string().optional().describe("Task id for task-scoped markers"),
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
      if (authorization.action === "capture-verified" && (context as unknown as { agent?: unknown }).agent !== "build") {
        return response(false, "capture-verified is restricted to the parent build agent")
      }
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
      if (!isSafeFeatureId(featureID)) {
        throw new Error("[marker-authority] safe feature_id required")
      }
      authorizedArgs.set(args, { sessionID, callID, featureID, action })
    },
  }
}

export default MarkerAuthority
