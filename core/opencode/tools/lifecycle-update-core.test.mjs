/** @description Lifecycle updates accept only a release tag and derive a fixed argv without shell interpolation. */
import test from "node:test";
import assert from "node:assert/strict";
import { buildLifecycleUpdateInvocation } from "./lifecycle-update-core.mjs";

test("buildLifecycleUpdateInvocation derives the exact vendoring command from verified runtime markers", () => {
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
        "both",
        "--ref",
        "v1.2.3",
      ],
      target: "both",
    },
  );
});

test("buildLifecycleUpdateInvocation rejects a tag that could alter argv or a project without a runtime", () => {
  assert.throws(
    () => buildLifecycleUpdateInvocation({ tag: "v1.2.3 --admin", hasOpenCode: true, hasClaude: false }),
    /invalid release tag/i,
  );
  assert.throws(
    () => buildLifecycleUpdateInvocation({ tag: "v1.2.3", hasOpenCode: false, hasClaude: false }),
    /no installed harness runtime/i,
  );
  assert.throws(
    () => buildLifecycleUpdateInvocation({ tag: "v1.2.3", hasOpenCode: false, hasClaude: false, requestedTarget: "opencode; rm -rf /" }),
    /invalid lifecycle target/i,
  );
});

test("buildLifecycleUpdateInvocation allows an explicit runtime only for a first installation", () => {
  const invocation = buildLifecycleUpdateInvocation({
    tag: "v1.2.3",
    hasOpenCode: false,
    hasClaude: false,
    requestedTarget: "opencode",
  });

  assert.equal(invocation.target, "opencode");
  assert.deepEqual(invocation.args.slice(-4), ["--target", "opencode", "--ref", "v1.2.3"]);
  assert.throws(
    () => buildLifecycleUpdateInvocation({ tag: "v1.2.3", hasOpenCode: true, hasClaude: false, requestedTarget: "both" }),
    /installed runtime markers/i,
  );
});
