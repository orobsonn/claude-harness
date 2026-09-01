/** @description Builds the fixed argv for a harness lifecycle update without a shell parser. */

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Construct the only supported vendoring invocation. Lifecycle always restores every runtime.
 * @param {{ tag: unknown, hasOpenCode: boolean, hasClaude: boolean, requestedTarget?: unknown }} input
 * @returns {{ command: "npx", args: string[], target: "all" }}
 */
export function buildLifecycleUpdateInvocation({ tag, hasOpenCode, hasClaude, requestedTarget }) {
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) {
    throw new Error("invalid release tag")
  }
  if (requestedTarget !== undefined && requestedTarget !== "all") {
    throw new Error("invalid lifecycle target")
  }
  const target = "all"

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
