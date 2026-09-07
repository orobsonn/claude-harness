/** @description Builds the fixed argv for a harness lifecycle update without a shell parser. */

const RELEASE_TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Construct the only supported vendoring invocation. Lifecycle defaults to every runtime, while an
 * explicit, allowlisted runtime selection remains available when the operator requests it.
 * @param {{ tag: unknown, hasOpenCode: boolean, hasClaude: boolean, requestedTarget?: unknown }} input
 * @returns {{ command: "npx", args: string[], target: "claude"|"opencode"|"codex"|"pi"|"both"|"all" }}
 */
export function buildLifecycleUpdateInvocation({ tag, hasOpenCode, hasClaude, requestedTarget }) {
  if (typeof tag !== "string" || !RELEASE_TAG.test(tag)) {
    throw new Error("invalid release tag")
  }
  const target = requestedTarget ?? "all"
  if (!["claude", "opencode", "codex", "pi", "both", "all"].includes(target)) {
    throw new Error("invalid lifecycle target")
  }

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
