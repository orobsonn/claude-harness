/** @description
 * The `classify` native tool for the OpenCode harness.
 * Validates the model's triage choice, stamps session gate state, and returns
 * the stable `.opencode/plans/<feature_id>/execution-plan.json` path.
 */

import { tool } from "@opencode-ai/plugin/tool"
import fs from "node:fs"

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
 * @description Core execute logic — validates triage, stamps gate-state, and never writes a plan.
 */
export async function executeClassify(
  args: { mode?: unknown; feature_id?: unknown },
  context: ClassifyContext,
): Promise<{
  title: string
  output: string
  metadata: Record<string, unknown>
}> {
  const { decideClassifyTransition } = await import(
    "../shared/lib/classify-stub.mjs"
  )
  const { isSafeSessionId } = await import("../shared/lib/feature-id.mjs")
  const { executionPlanPath, gateStatePath } = await import("../shared/lib/path-helpers.mjs")
  const { FRESH_CLASSIFY_STATE_KEYS_TO_REMOVE, persistClassifyState } = await import(
    "./lib/classify-persist.mjs"
  )

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
    "../shared/lib/classify-authority.mjs"
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

  const pp = executionPlanPath({
    projectRoot: context.directory,
    runtime: "opencode",
    featureId: finalFeatureId,
  })
  if (!pp.ok) {
    return errorResult("invalid plan path", pp.reason, finalFeatureId)
  }
  const planPath = pp.path

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

  const persisted = persistClassifyState({
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
    "Classify the current request into a triage mode and persist session triage state. " +
    "The model passes { mode, feature_id } where mode ∈ { no-ceremony, QUICK, LIGHT, FULL }. " +
    "Returns the stable <directory>/.opencode/plans/<feature_id>/execution-plan.json path and " +
    "echoed { mode, feature_id, action } metadata. Classification never creates or changes the plan.",
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
