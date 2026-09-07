/** @description
 * Thin OC tool wrapper for shared complexity-scorer (T5b).
 * Reads file and delegates to pure scoreFile. Per 03 contract.
 */
import { tool } from "@opencode-ai/plugin/tool"
import fs from "node:fs"
import path from "node:path"

export interface ComplexityContext {
  directory: string
}

export async function executeComplexityScorer(
  args: { path?: unknown; file_path?: unknown },
  context: ComplexityContext,
): Promise<{ title: string; output: string; metadata: Record<string, unknown> }> {
  const { scoreFile } = await import("../shared/lib/complexity-scorer.mjs")

  const filePath = typeof args.path === "string" ? args.path.trim() : typeof args.file_path === "string" ? args.file_path.trim() : ""
  if (!filePath) {
    return {
      title: "complexity-scorer: missing file_path",
      output: JSON.stringify({ error: "file_path required" }),
      metadata: { error: "file_path required" },
    }
  }

  try {
    const full = path.resolve(context.directory, filePath)
    const source = fs.readFileSync(full, "utf8")
    const result = scoreFile(source, filePath)
    return {
      title: `complexity: ${result.ok ? result.band : "error"}`,
      output: JSON.stringify(result, null, 2),
      metadata: result,
    }
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e)
    return {
      title: "complexity-scorer: read error",
      output: JSON.stringify({ ok: false, reason }),
      metadata: { ok: false, reason },
    }
  }
}

export default tool({
  description: "Score source file complexity for executor routing (shared pure core)",
  args: {
    path: tool.schema.string().describe("relative path to source file"),
  },
  async execute(args, context) {
    return executeComplexityScorer(args, context as ComplexityContext)
  },
})
