/** @description
 * Thin OC tool wrapper for shared validatePlan (issue #373 / B1).
 * Accepts a plan path (relative to context.directory) and/or inline plan JSON.
 * Never throws; returns { title, output, metadata } with ok/errors.
 */
import { tool } from "@opencode-ai/plugin/tool"
import fs from "node:fs"
import path from "node:path"

export interface ValidatePlanContext {
  directory: string
}

/**
 * @description Core execute logic — load plan from path and/or args.plan, run shared validatePlan.
 */
export async function executeValidatePlan(
  args: { path?: unknown; plan?: unknown; expect?: unknown },
  context: ValidatePlanContext,
): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> {
  const { validatePlan } = await import("../../shared/lib/validate-plan.mjs")

  const expectRaw = typeof args.expect === "string" ? args.expect.trim() : "full"
  const expect =
    expectRaw === "stub" || expectRaw === "full" || expectRaw === "any" ? expectRaw : "full"

  let plan: unknown = null
  const planPath = typeof args.path === "string" ? args.path.trim() : ""

  if (planPath) {
    try {
      const full = path.resolve(context.directory, planPath)
      const raw = fs.readFileSync(full, "utf8")
      plan = JSON.parse(raw)
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e)
      const payload = { ok: false, errors: [`failed to read/parse plan path: ${reason}`], path: planPath }
      return {
        title: "validate-plan: read error",
        output: JSON.stringify(payload, null, 2),
        metadata: payload,
      }
    }
  } else if (args.plan !== undefined && args.plan !== null) {
    if (typeof args.plan === "string") {
      try {
        plan = JSON.parse(args.plan)
      } catch (e: unknown) {
        const reason = e instanceof Error ? e.message : String(e)
        const payload = { ok: false, errors: [`failed to parse plan JSON string: ${reason}`] }
        return {
          title: "validate-plan: parse error",
          output: JSON.stringify(payload, null, 2),
          metadata: payload,
        }
      }
    } else if (typeof args.plan === "object") {
      plan = args.plan
    } else {
      const payload = { ok: false, errors: ["plan must be a JSON object or JSON string"] }
      return {
        title: "validate-plan: invalid plan arg",
        output: JSON.stringify(payload, null, 2),
        metadata: payload,
      }
    }
  } else {
    const payload = {
      ok: false,
      errors: ["path or plan required — pass a repo-relative plan path and/or inline plan JSON"],
    }
    return {
      title: "validate-plan: missing input",
      output: JSON.stringify(payload, null, 2),
      metadata: payload,
    }
  }

  const result = validatePlan(plan, { expect })
  const metadata = {
    ok: result.ok,
    errors: result.errors,
    expect,
    ...(planPath ? { path: planPath } : {}),
  }
  return {
    title: result.ok ? "validate-plan: OK" : `validate-plan: ${result.errors.length} error(s)`,
    output: JSON.stringify(metadata, null, 2),
    metadata,
  }
}

export default tool({
  description:
    "Structurally validate an execution-plan.json (shared validatePlan). " +
    "Pass path (repo-relative) and/or plan (inline object/JSON string). " +
    "Optional expect: stub|full|any (default full). Returns { ok, errors }.",
  args: {
    path: tool.schema.string().optional().describe("repo-relative path to execution-plan.json"),
    plan: tool.schema
      .string()
      .optional()
      .describe("inline plan as a JSON string (alternative to path)"),
    expect: tool.schema
      .string()
      .optional()
      .describe("validation mode: stub | full | any (default full)"),
  },
  async execute(args, context) {
    return executeValidatePlan(args, context as ValidatePlanContext)
  },
})
