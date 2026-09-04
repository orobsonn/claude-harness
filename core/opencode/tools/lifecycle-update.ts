/** @description Native build-only lifecycle update tool with fixed argv and host confirmation. */
import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { tool } from "@opencode-ai/plugin/tool"

const execFileAsync = promisify(execFile)

async function latestReleaseTag(): Promise<string> {
  const { stdout } = await execFileAsync("gh", [
    "release",
    "view",
    "--repo",
    "orobsonn/claude-harness",
    "--json",
    "tagName",
    "-q",
    ".tagName",
  ], { timeout: 15_000, maxBuffer: 1024 * 1024 })
  return stdout.trim()
}

export default tool({
  description:
    "Update the installed harness through the verified, pinned lifecycle CLI. " +
    "Only root build sessions may invoke it; it defaults to all runtimes unless the operator explicitly selects one runtime, opens and squash-merges a manifest-only PR, then requires a new session.",
  args: {
    target: tool.schema.string().optional().describe("Optional explicit runtime target. Omit to update Claude Code, OpenCode, Codex, and Pi together."),
  },
  async execute(args, context) {
    await context.ask({
      permission: "lifecycle-update",
      patterns: ["run"],
      always: [],
      metadata: { action: "update-harness", impact: "updates the vendored harness and merges its lifecycle PR" },
    })
    const { buildLifecycleUpdateInvocation } = await import("./lifecycle-update-core.mjs")
    const tag = await latestReleaseTag()
    const invocation = buildLifecycleUpdateInvocation({
      tag,
      hasOpenCode: existsSync(join(context.directory, ".opencode", ".harness-version")),
      hasClaude: existsSync(join(context.directory, ".claude", ".harness-version")),
      requestedTarget: args.target,
    })
    const { stdout = "", stderr = "" } = await execFileAsync(invocation.command, invocation.args, {
      cwd: context.directory,
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    })
    return {
      title: `lifecycle-update: ${tag}`,
      output: `${stdout}${stderr}`.trim(),
      metadata: { tag, target: invocation.target },
    }
  },
})
