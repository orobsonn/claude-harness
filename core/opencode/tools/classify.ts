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
  const { buildClassifyStub } = await import("../../shared/lib/classify-stub.mjs")
  const { isSafeSessionId } = await import("../../shared/lib/feature-id.mjs")
  const { planDir, gateStatePath } = await import("../../shared/lib/path-helpers.mjs")
  const { mergeGateState } = await import("../plugin/lib/gate-state.mjs")

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

  const built = buildClassifyStub({ mode, featureId, sessionId: sessionID })
  if (!built.ok || !built.stub) {
    return errorResult(
      built.reason === "invalid featureId" ? "invalid feature_id" : built.reason ?? "invalid",
      "mode ∈ { no-ceremony, QUICK, LIGHT, FULL }; feature_id kebab-case",
      JSON.stringify({ mode, feature_id: featureId }),
    )
  }

  const pd = planDir({
    projectRoot: context.directory,
    runtime: "opencode",
    sessionId: sessionID,
    featureId,
  })
  if (!pd.ok) {
    return errorResult("invalid plan path", pd.reason, featureId)
  }

  const planPath = path.join(pd.path, "execution-plan.json")

  if (fs.existsSync(planPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(planPath, "utf8")) as Record<string, unknown>
      if (Array.isArray(existing.tasks) && existing.tasks.length > 0) {
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

  const tmpPath = `${planPath}.tmp`
  const dirPreexisted = fs.existsSync(pd.path)
  let dirCreated = false
  try {
    if (!dirPreexisted) {
      fs.mkdirSync(pd.path, { recursive: true })
      dirCreated = true
    }
    fs.writeFileSync(tmpPath, JSON.stringify(built.stub, null, 2), "utf8")
    fs.renameSync(tmpPath, planPath)
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {
      /* ignore */
    }
    if (dirCreated) {
      try {
        fs.rmSync(pd.path, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return errorResult("write failed", msg.slice(0, 200), planPath)
  }

  const gs = gateStatePath({
    projectRoot: context.directory,
    runtime: "opencode",
    sessionId: sessionID,
  })
  if (gs.ok) {
    mergeGateState(gs.path, {
      session_id: sessionID,
      feature_id: featureId,
      mode,
      classified: true,
      triaged: true,
    })
  }

  const metadata = { plan_path: planPath, mode, feature_id: featureId }
  return {
    title: `classify: ${featureId} → ${mode}`,
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
    "The stub is a PRE-PLAN artifact (empty tasks) — the planner overwrites it with a full plan later.",
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
