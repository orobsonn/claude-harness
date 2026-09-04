/** @description Lifecycle updates accept only a release tag and derive a fixed argv without shell interpolation. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildLifecycleUpdateInvocation } from "./lifecycle-update-core.mjs";

test("buildLifecycleUpdateInvocation always synchronizes all runtime harnesses", () => {
  assert.deepEqual(
    buildLifecycleUpdateInvocation({ tag: "v1.2.3", hasOpenCode: true, hasClaude: true }),
    {
      command: "npx",
      args: [
        "--yes",
        "--package=github:orobsonn/claude-harness#v1.2.3",
        "claude-harness",
        "lifecycle-update",
        "--target",
        "all",
        "--ref",
        "v1.2.3",
      ],
      target: "all",
    },
  );
});

test("buildLifecycleUpdateInvocation rejects a tag or target that could alter argv", () => {
  assert.throws(
    () => buildLifecycleUpdateInvocation({ tag: "v1.2.3 --admin", hasOpenCode: true, hasClaude: false }),
    /invalid release tag/i,
  );
  assert.throws(
    () => buildLifecycleUpdateInvocation({ tag: "v1.2.3", hasOpenCode: false, hasClaude: false, requestedTarget: "opencode; rm -rf /" }),
    /invalid lifecycle target/i,
  );
});

test("buildLifecycleUpdateInvocation defaults to all four runtimes and preserves every explicit target", () => {
  for (const target of [undefined, "claude", "opencode", "codex", "pi", "both", "all"]) {
    const invocation = buildLifecycleUpdateInvocation({
      tag: "v1.2.3",
      hasOpenCode: false,
      hasClaude: false,
      requestedTarget: target,
    });
    assert.equal(invocation.target, target ?? "all");
    assert.deepEqual(invocation.args.slice(-4), ["--target", target ?? "all", "--ref", "v1.2.3"]);
  }
});
