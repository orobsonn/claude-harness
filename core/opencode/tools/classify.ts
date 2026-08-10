/** @description
 * The `classify` native tool for the OpenCode harness.
 * Builds a pre-plan stub via shared buildClassifyStub and writes it under
 * .opencode/plans/<sessionID>-<feature_id>/execution-plan.json. Stamps gate-state markers.
 */

import { tool } from "@opencode-ai/plugin/tool"
import fs from "node:fs"
import path from "node:path"

function errorResult(error: string, hint: string, received: string) {
  const payload = { error, hint, received }
  return {
    title: `classify: ${error.toLowerCase()}`,
    output: JSON.stringify(payload, null, 2),
    metadata: payload,
  }
}

export interface ClassifyContext {
  directory: string
  sessionID: string
  /** Acting agent when the host surfaces it (build only). */
  agent?: string
  /** Parent session id when this is a Task child — classify must deny. */
  parentSessionId?: string | null
}

/**
 * @description Core execute logic — validates via buildClassifyStub, writes stub, stamps gate-state.
 */
export async function executeClassify(
  args: { mode?: unknown; feature_id?: unknown },
  context: ClassifyContext,
): Promise<{
  title: string
  output: string
  metadata: Record<string, unknown>
}> {
  const { buildClassifyStub, decideClassifyTransition } = await import(
    "../../shared/lib/classify-stub.mjs"
  )
  const { isSafeSessionId } = await import("../../shared/lib/feature-id.mjs")
  const { planDir, gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE, persistClassifyArtifacts } = await import(
    "./lib/classify-persist.mjs"
  )
  const { plannerCycleResetPatch } = await import("../lib/planner-state.mjs")

  const featureId = typeof args.feature_id === "string" ? args.feature_id.trim() : ""
  const mode = typeof args.mode === "string" ? args.mode.trim() : ""
  const sessionID = context.sessionID

  if (!isSafeSessionId(sessionID)) {
    return errorResult(
      "invalid sessionID",
      "sessionID must pass isSafeSessionId",
      typeof sessionID === "string" ? sessionID : "",
    )
  }

  // Belt: top-level build only (entry-gate is the primary rail).
  const { decideClassifyAuthority } = await import(
    "../../shared/lib/classify-authority.mjs"
  )
  const agent =
    typeof context.agent === "string"
      ? context.agent
      : typeof (context as { agentName?: unknown }).agentName === "string"
        ? String((context as { agentName?: string }).agentName)
        : ""
  const parentSessionId =
    typeof context.parentSessionId === "string" ? context.parentSessionId : null
  const auth = decideClassifyAuthority({ agent, parentSessionId, sessionId: sessionID })
  if (!auth.ok) {
    return errorResult(
      auth.reason,
      "only top-level build may classify; hands/eyes execute their brief only",
      JSON.stringify({ agent, parentSessionId, sessionID }),
    )
  }

  const gsPath = gateStatePath({
    projectRoot: context.directory,
    runtime: "opencode",
    sessionId: sessionID,
  })
  if (!gsPath.ok) return errorResult("invalid gate-state path", gsPath.reason, sessionID)

  let prior: Record<string, unknown> = {}
  try {
    if (fs.existsSync(gsPath.path)) {
      const loaded = JSON.parse(fs.readFileSync(gsPath.path, "utf8")) as unknown
      if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        prior = loaded as Record<string, unknown>
      }
    }
  } catch {
    prior = {}
  }

  const transition = decideClassifyTransition({
    requestedMode: mode,
    requestedFeatureId: featureId,
    currentMode: prior.mode,
    currentFeatureId: prior.feature_id,
    peakMode: prior.peak_mode,
    classified: prior.classified === true || prior.triaged === true,
  })
  if (!transition.ok) {
    return errorResult(
      transition.reason,
      "classify is escalate-only for an active session+feature; never downgrade or switch feature mid-run",
      JSON.stringify({ mode, feature_id: featureId }),
    )
  }

  const finalMode = transition.mode
  const finalFeatureId = transition.featureId
  const peakMode = transition.peakMode

  // A feature outlives a chat session. On a fresh session, adopt its most recent durable
  // workflow state before creating a stub so planner/review/task progress is not discarded.
  if (transition.action === "fresh") {
    const { adoptFeatureResume, findFeatureResume } = await import("../lib/feature-resume.mjs")
    const resume = findFeatureResume(context.directory, finalFeatureId)
    if (resume && resume.sessionId !== sessionID) {
      const adopted = adoptFeatureResume(context.directory, sessionID, resume, finalMode)
      if (!adopted.ok) {
        return errorResult("feature resume failed", adopted.reason, finalFeatureId)
      }
      const metadata = {
        plan_path: adopted.planPath,
        mode: resume.state.mode,
        feature_id: finalFeatureId,
        action: finalMode === resume.state.mode && resume.state.session_status !== "completed" &&
          resume.state.final_review_done !== true && resume.state.planner_status === "usable" && resume.state.plan_review_verdict === "APPROVE" &&
          (resume.state.mode === "LIGHT" || resume.state.mode === "FULL")
          ? "resume-approved-plan"
          : "resume",
        source_session_id: resume.sessionId,
      }
      return {
        title: `classify: resumed ${finalFeatureId}`,
        output: JSON.stringify(metadata, null, 2),
        metadata,
      }
    }
  }

  const built = buildClassifyStub({
    mode: finalMode,
    featureId: finalFeatureId,
    sessionId: sessionID,
  })
  if (!built.ok || !built.stub) {
    return errorResult(
      built.reason === "invalid featureId" ? "invalid feature_id" : built.reason ?? "invalid",
      "mode ∈ { no-ceremony, QUICK, LIGHT, FULL }; feature_id kebab-case",
      JSON.stringify({ mode: finalMode, feature_id: finalFeatureId }),
    )
  }

  const pd = planDir({
    projectRoot: context.directory,
    runtime: "opencode",
    sessionId: sessionID,
    featureId: finalFeatureId,
  })
  if (!pd.ok) {
    return errorResult("invalid plan path", pd.reason, finalFeatureId)
  }

  const planPath = path.join(pd.path, "execution-plan.json")

  if (fs.existsSync(planPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>
      if (Array.isArray(existing.tasks) && existing.tasks.length > 0) {
        if (transition.action === "noop") {
          const metadata = {
            plan_path: planPath,
            mode: finalMode,
            feature_id: finalFeatureId,
            action: "noop",
            peak_mode: peakMode,
          }
          return {
            title: `classify: ${finalFeatureId} → ${finalMode} (noop)`,
            output: JSON.stringify(metadata, null, 2),
            metadata,
          }
        }
        return errorResult(
          "plan already exists",
          "classify will not overwrite an existing full plan",
          planPath,
        )
      }
    } catch {
      /* allow overwrite of corrupt stub */
    }
  }

  // Replay: do not wipe planner facts, planner, or review state; do not re-emit obs.
  if (transition.action === "noop") {
    const metadata = {
      plan_path: planPath,
      mode: finalMode,
      feature_id: finalFeatureId,
      action: "noop",
      peak_mode: peakMode,
    }
    return {
      title: `classify: ${finalFeatureId} → ${finalMode} (noop)`,
      output: JSON.stringify(metadata, null, 2),
      metadata,
    }
  }

  /** @type {Record<string, unknown>} */
  const statePatch: Record<string, unknown> = {
    session_id: sessionID,
    feature_id: finalFeatureId,
    mode: finalMode,
    peak_mode: peakMode,
    classified: true,
    triaged: true,
  }

  if (transition.action === "fresh") {
    Object.assign(statePatch, {
      brainstormed: false,
      adversary_fired: false,
      marker_seals: null,
      ...plannerCycleResetPatch(),
    })
  } else {
    // escalate: keep planner facts/review/planner; only raise mode + peak
    statePatch.mode = finalMode
    statePatch.peak_mode = peakMode
  }

  const persisted = persistClassifyArtifacts({
    planPath,
    stub: built.stub,
    statePath: gsPath.path,
    statePatch,
    ...(transition.action === "fresh"
      ? { removeStateKeys: FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE }
      : {}),
  })
  if (!persisted.ok) {
    return errorResult("persistence failed", persisted.reason.slice(0, 200), planPath)
  }

  // Mid-run observability (#284): pipeline-type only on real transition.
  try {
    const { eventForPipelineType, obsAppend } = await import("../lib/obs-emit.mjs")
    const ev = eventForPipelineType(finalMode)
    if (ev) obsAppend(ev)
  } catch {
    /* fail-open */
  }

  const metadata = {
    plan_path: planPath,
    mode: finalMode,
    feature_id: finalFeatureId,
    action: transition.action,
    peak_mode: peakMode,
  }
  return {
    title: `classify: ${finalFeatureId} → ${finalMode}`,
    output: JSON.stringify(metadata, null, 2),
    metadata,
  }
}

export default tool({
  description:
    "Classify the current request into a triage mode and write a pre-plan stub. " +
    "The model passes { mode, feature_id } where mode ∈ { no-ceremony, QUICK, LIGHT, FULL }. " +
    "The stub is written to <directory>/.opencode/plans/<sessionID>-<feature_id>/execution-plan.json. " +
    "Returns the canonical plan path and echoed { mode, feature_id } in metadata. " +
    "The stub is a PRE-PLAN artifact (empty tasks) — the planner returns JSON only; planner-recovery (the host adapter) overwrites the stub with the validated full plan.",
  args: {
    mode: tool.schema
      .string()
      .describe("Classification mode: no-ceremony | QUICK | LIGHT | FULL"),
    feature_id: tool.schema
      .string()
      .describe(
        "Feature identifier in kebab-case (e.g. user-auth-revamp). Path separators, uppercase, and underscores are rejected.",
      ),
  },
  async execute(args, context) {
    return executeClassify(args, context as ClassifyContext)
  },
})
