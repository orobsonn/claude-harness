/** @description Native tools that prepare and finalize optional second-eye policy-B adjudication. */

import type { Plugin } from "@opencode-ai/plugin"
import fs from "node:fs"
import path from "node:path"
import { gateStatePath } from "../../shared/lib/path-helpers.mjs"
import { parseReviewReportText } from "../../shared/lib/review-report-schema.mjs"
import { reviewAgentIdentity } from "../agents/review-catalog.mjs"
import { reviewReportHash } from "./lib/loop-decide.mjs"
import {
  finalizeSecondEyeAdjudication,
  prepareSecondEyeAdjudication,
} from "../skills/orchestrating-delivery/second-eye-runtime.mjs"
import {
  consumeSecondEyeDispatch,
  consumePreparedAdjudication,
  sealPreparedAdjudication,
} from "./lib/second-eye-authority.mjs"

function parse(value: string) {
  try { return JSON.parse(value) } catch { return null }
}

function capturedReport(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value
  return typeof value === "string" ? parseReviewReportText(value) : null
}

function loadRouting(projectRoot: string) {
  for (const candidate of [".opencode/harness.routing.json", "harness.routing.json"]) {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(projectRoot, candidate), "utf8"))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed
    } catch {
      // Try the other canonical runtime location.
    }
  }
  return null
}

function loadPrimaryReport(projectRoot: string, sessionId: string, role: string) {
  const statePath = gateStatePath({ projectRoot, runtime: "opencode", sessionId })
  if (!statePath.ok) return null
  try {
    const state = JSON.parse(fs.readFileSync(statePath.path, "utf8"))
    const outcomes = Array.isArray(state.review_outcomes) ? state.review_outcomes : []
    const latest = outcomes.filter((item: Record<string, unknown>) => item?.logical_role === role && item?.outcome === "useful").at(-1)
    const epoch = Number.isInteger(state.review_epoch) && state.review_epoch > 0 ? state.review_epoch : 1
    const expectedIdentity = reviewAgentIdentity(role)?.canonicalName
    const receiptIdentity = reviewAgentIdentity(latest?.canonical_identity)?.canonicalName
    const report = state.primary_review_last_report
    if (
      !latest || !report || typeof report !== "object" || Array.isArray(report) ||
      state.session_id !== sessionId || latest.session_id !== sessionId ||
      latest.epoch !== epoch || latest.family !== 1 ||
      !expectedIdentity || receiptIdentity !== expectedIdentity ||
      latest.feature_id !== state.feature_id ||
      latest.report_hash !== state.primary_review_last_report_hash ||
      latest.report_hash !== reviewReportHash(report)
    ) return null
    return {
      report,
      featureId: state.feature_id,
      epoch,
      primaryReportHash: latest.report_hash,
    }
  } catch {
    return null
  }
}

function response(result: Record<string, unknown>) {
  return {
    title: result.ok ? `second-eye: ${result.action}` : "second-eye: rejected",
    output: JSON.stringify(result, null, 2),
    metadata: result,
  }
}

export const SecondEyeCoordinator: Plugin = async ({ directory, worktree }: any) => {
  const { tool } = await import("@opencode-ai/plugin/tool")
  const projectRoot = typeof directory === "string" && directory
    ? directory
    : typeof worktree === "string" && worktree
      ? worktree
      : process.cwd()
  const prepare = tool({
    description: "Prepare policy-B adjudication after primary and optional second-eye reports return.",
    args: {
      role: tool.schema.string(),
    },
    async execute(args, context) {
      const primary = loadPrimaryReport(projectRoot, context.sessionID, args.role)
      if (!primary) return response({ ok: false, action: "rejected", reason: "authoritative primary report missing" })
      const secondary = consumeSecondEyeDispatch({
        sessionId: context.sessionID,
        role: args.role,
        featureId: primary.featureId,
        epoch: primary.epoch,
        primaryReportHash: primary.primaryReportHash,
      })
      const prepared = prepareSecondEyeAdjudication({
        role: args.role,
        routing: loadRouting(projectRoot),
        primaryResult: primary.report,
        secondaryResult: secondary.ok ? capturedReport(secondary.result) : null,
        adjudicationContext: primary,
      })
      return response(sealPreparedAdjudication(prepared, { sessionId: context.sessionID }))
    },
  })
  const finalize = tool({
    description: "Finalize policy-B adjudication after the one budgeted primary refute-pass returns or fails.",
    args: {
      adjudication_id: tool.schema.string(),
    },
    async execute(args, context) {
      const stored = consumePreparedAdjudication(args.adjudication_id, { sessionId: context.sessionID })
      if (!stored.ok) return response({ ok: false, action: "rejected", reason: stored.reason })
      return response(finalizeSecondEyeAdjudication(stored.prepared, {
        refuteResult: stored.refuteResult,
        refutePassAttemptCount: stored.refutePassAttemptCount,
      }))
    },
  })
  return { tool: { "second-eye-prepare": prepare, "second-eye-finalize": finalize } }
}

export default SecondEyeCoordinator
