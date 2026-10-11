import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureTaskRuntime, verifyTaskRuntime } from "./task-runtime.mjs";

function runtimeTree(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lane-runtime-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const file of [".claude/hooks/task-gate.mjs", ".claude/hooks/lib/task-launcher.mjs", ".claude/shared/lib/x.mjs", ".claude/agents/executor.md",
    ".claude/settings.json", ".claude/skills/orchestrating-delivery/references/task-runtime.md",
    ".claude/skills/orchestrating-delivery/references/eye-tier.mjs", ".claude/skills/creating-plans/references/validate-plan.mjs"]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  return root;
}

test("the lane runtime manifest detects any harness change before a launch", (t) => {
  const root = runtimeTree(t);
  const runtime = captureTaskRuntime(root);
  assert.equal(runtime.launcher_path, path.join(root, ".claude/hooks/lib/task-launcher.mjs"));
  assert.equal(verifyTaskRuntime(runtime).ok, true);
  fs.writeFileSync(path.join(root, ".claude/hooks/task-gate.mjs"), "// disabled");
  assert.match(verifyTaskRuntime(runtime).reason, /changed since the worktree was prepared/);
  fs.writeFileSync(path.join(root, ".claude/hooks/task-gate.mjs"), ".claude/hooks/task-gate.mjs");
  assert.equal(verifyTaskRuntime(runtime).ok, true);
  fs.writeFileSync(path.join(root, ".claude/hooks/new-hook.mjs"), "x");
  assert.equal(verifyTaskRuntime(runtime).ok, false, "an added file changes the manifest");
  fs.rmSync(path.join(root, ".claude/hooks/new-hook.mjs"));
  fs.writeFileSync(path.join(root, ".claude/hooks/task-gate.test.mjs"), "tests are not runtime");
  assert.equal(verifyTaskRuntime(runtime).ok, true);
  assert.equal(verifyTaskRuntime({ ...runtime, sha256: "nope" }).ok, false);
  fs.symlinkSync("/etc/passwd", path.join(root, ".claude/hooks/link.mjs"));
  assert.match(verifyTaskRuntime(runtime).reason, /symlink/);
});

test("a worktree without the vendored harness cannot host a lane", (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lane-runtime-empty-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => captureTaskRuntime(root), /Commit the vendored \.claude\/ harness/);
});
