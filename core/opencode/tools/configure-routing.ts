/** @description
 * Native OC tool for the `oc-configuring-model-routing` skill. Binds the pure core
 * (configure-routing-core.mjs) to the OC tool runtime. Running in-process means routing
 * reconfiguration never touches the bash forge/interpreter gate — hand-editing the
 * touchpoints with sed/perl is what the anti-forgery gate (correctly) blocks, so this
 * tool is the ONLY sanctioned way to mutate routing.
 *
 * targetRoot is always context.directory (cwd). Every apply also invokes the host-owned
 * confirmation channel; model-supplied confirmation flags never substitute for it.
 */
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { tool } from "@opencode-ai/plugin/tool"

const execFileAsync = promisify(execFile)

export interface ConfigureRoutingContext {
  directory: string
}

/**
 * List model slugs the OpenCode binary reports (`opencode models`). Fixed command,
 * no user input in argv (no injection surface). Callers treat a throw as fail-open.
 */
async function listInstalledModels(): Promise<string[]> {
  const { stdout } = await execFileAsync("opencode", ["models"], {
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("/"))
}

export default tool({
  description:
    "Reconfigure harness model routing via the sanctioned engine (in-process; the ONLY safe way to mutate routing — never hand-edit the touchpoints). " +
    "action 'inspect' returns presets + touchpoints + current routing (read-only). " +
    "action 'apply' writes all touchpoints atomically with rollback. " +
    "Pass preset (id, primary form) OR slots (JSON object, escape hatch). " +
    "targetRoot is always the cwd. Every apply requires explicit host confirmation; weak-eye flags never replace it.",
  args: {
    action: tool.schema.string().optional().describe("'inspect' (read-only map) or 'apply' (default)"),
    preset: tool.schema.string().optional().describe("preset id from listPresets() — primary form for apply"),
    slots: tool.schema.string().optional().describe("inline slots as a JSON string (escape hatch when no preset fits)"),
    update_opencode_json: tool.schema.boolean().optional().describe("also update opencode.json model/small_model (default true)"),
    confirm_weak_eyes: tool.schema.boolean().optional().describe("allow weak SUPPORT eyes — only after operator confirmation"),
    confirm_weak_judgment_eyes: tool.schema
      .boolean()
      .optional()
      .describe("allow weak JUDGMENT eyes (adversary/plan-reviewer) — degrades the safety net; only after explicit operator confirmation"),
    force_core_grok: tool.schema.boolean().optional().describe("allow xAI/Grok on harness source (CI-banned by default)"),
  },
  async execute(args, context) {
    const action = typeof args.action === "string" && args.action.trim() ? args.action.trim() : "apply"
    if (action === "apply") {
      await context.ask({
        permission: "configure-routing",
        patterns: ["apply"],
        always: [],
        metadata: { action: "apply", impact: "changes harness model routing" },
      })
    }
    const { runConfigureRouting } = await import("./configure-routing-core.mjs")
    const engine = await import("../skills/configuring-model-routing/references/apply-routing.mjs")
    return runConfigureRouting(args, context as ConfigureRoutingContext, engine, {
      listModels: listInstalledModels,
    })
  },
})
