/** @description Builds the fixed argv for a harness lifecycle update without a shell parser. */

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Resolve installed runtime markers and construct the only supported vendoring invocation.
 * @param {{ tag: unknown, hasOpenCode: boolean, hasClaude: boolean, requestedTarget?: unknown }} input
 * @returns {{ command: "npx", args: string[], target: "opencode" | "claude" | "both" }}
 */
export function buildLifecycleUpdateInvocation({ tag, hasOpenCode, hasClaude, requestedTarget }) {
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) {
    throw new Error("invalid release tag")
  }
  const detectedTarget = hasOpenCode && hasClaude ? "both" : hasOpenCode ? "opencode" : hasClaude ? "claude" : null
  if (requestedTarget !== undefined && requestedTarget !== "opencode" && requestedTarget !== "claude" && requestedTarget !== "both") {
    throw new Error("invalid lifecycle target")
  }
  if (detectedTarget !== null && requestedTarget !== undefined && requestedTarget !== detectedTarget) {
    throw new Error("installed runtime markers determine the lifecycle target")
  }
  const target = detectedTarget ?? requestedTarget
  if (target === undefined || target === null) throw new Error("no installed harness runtime; state an installation target")

  return {
    command: "npx",
    args: [
      "--yes",
      `--package=github:orobsonn/claude-harness#${tag}`,
      "claude-harness",
      "lifecycle-update",
      "--target",
      target,
      "--ref",
      tag,
    ],
    target,
  }
}
