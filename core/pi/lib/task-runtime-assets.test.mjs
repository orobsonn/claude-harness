import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  captureTaskRuntime,
  verifyTaskRuntime,
  resolveTaskRuntimeLauncher,
} from "./task-runtime-assets.mjs";

const put = (root, name, value = "asset") => {
  const file = path.join(root, ...name.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
};
function sourceFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-source-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const launcher = put(root, "core/pi/bin/pi-harness.mjs", "launcher");
  put(root, "core/pi/lib/local.mjs", "local");
  put(root, "core/pi/runtime/settings.json", "{}");
  put(root, "core/shared/lib/upstream.mjs", "shared");
  put(root, "core/codex/lib/upstream.mjs", "codex");
  put(root, "core/opencode/lib/upstream.mjs", "opencode");
  return { root, launcher };
}
function vendorFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-vendor-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const harness = path.join(root, ".pi/harness");
  const launcher = put(harness, "bin/pi-harness.mjs", "launcher");
  for (const dir of [
    "extensions",
    "lib",
    "prompts",
    "skills",
    "vendor",
    "runtime-defaults",
    "runtime-deps",
  ])
    put(harness, `${dir}/asset`);
  return { root, harness, launcher };
}
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function repository(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-repo-"));
  const launcher = put(root, "core/pi/bin/pi-harness.mjs", "launcher");
  put(root, "core/pi/lib/local.mjs", "local");
  put(root, "core/pi/runtime/settings.json", "{}");
  put(root, "core/shared/lib/upstream.mjs");
  put(root, "core/codex/lib/upstream.mjs");
  put(root, "core/opencode/lib/upstream.mjs");
  put(root, ".pi/harness/bin/pi-harness.mjs", "vendor launcher");
  git(root, "init", "-q");
  git(root, "config", "user.name", "Harness");
  git(root, "config", "user.email", "harness@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  const base = git(root, "rev-parse", "HEAD");
  const worktree = `${root}-task`;
  git(root, "worktree", "add", "-qb", "task", worktree, base);
  t.after(() => {
    try {
      git(root, "worktree", "remove", "--force", worktree);
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, launcher, base, worktree };
}

test("source runtime digest changes for Pi code and conservative upstream assets", (t) => {
  const f = sourceFixture(t);
  const first = captureTaskRuntime(f.launcher);
  assert.equal(first.ok, true, first.reason);
  assert.equal(verifyTaskRuntime(first.runtime).ok, true);
  fs.appendFileSync(path.join(f.root, "core/pi/lib/local.mjs"), " changed");
  assert.match(verifyTaskRuntime(first.runtime).reason, /changed/);
  const second = captureTaskRuntime(f.launcher);
  fs.appendFileSync(
    path.join(f.root, "core/shared/lib/upstream.mjs"),
    " changed",
  );
  assert.match(verifyTaskRuntime(second.runtime).reason, /changed/);
});

test("vendored digest ignores mutable runtime, state, auth and tests without reading their content", (t) => {
  const f = vendorFixture(t);
  const auth = put(f.harness, "runtime-defaults/auth.json", "secret");
  put(f.harness, "lib/ignored.test.mjs", "test");
  put(f.harness, "runtime/settings.json", "mutable");
  put(f.harness, "state/session/record.json", "mutable");
  fs.rmSync(auth);
  const secret = put(f.root, "secret-target", "secret");
  fs.symlinkSync(secret, auth);
  const credentials = put(
    f.harness,
    "runtime-defaults/credentials/private.json",
    "secret",
  );
  const devVars = put(f.harness, "runtime-defaults/.dev.vars.local", "secret");
  const first = captureTaskRuntime(f.launcher);
  assert.equal(first.ok, true, first.reason);
  for (const file of [
    secret,
    credentials,
    devVars,
    path.join(f.harness, "lib/ignored.test.mjs"),
    path.join(f.harness, "runtime/settings.json"),
    path.join(f.harness, "state/session/record.json"),
  ])
    fs.appendFileSync(file, " changed");
  assert.equal(verifyTaskRuntime(first.runtime).ok, true);
});

test("managed asset symlinks and unsupported launcher layouts fail closed", (t) => {
  const f = vendorFixture(t);
  fs.symlinkSync(
    path.join(f.harness, "lib/asset"),
    path.join(f.harness, "lib/link.mjs"),
  );
  assert.match(captureTaskRuntime(f.launcher).reason, /symlink/);
  const other = put(f.root, "bin/pi-harness.mjs");
  assert.match(captureTaskRuntime(other).reason, /supported/);
});

test("self-hosting caches a detached base while vendored and external launchers map directly", (t) => {
  const f = repository(t);
  const runtimeRoot = path.join(f.root, ".pi/harness/state/runtime-bases");
  const first = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: f.launcher,
  });
  assert.equal(first.ok, true, first.reason);
  const before = captureTaskRuntime(first.launcherPath);
  assert.equal(before.ok, true, before.reason);
  fs.appendFileSync(
    path.join(f.worktree, "core/pi/lib/local.mjs"),
    " product change",
  );
  const again = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: f.launcher,
  });
  assert.equal(again.launcherPath, first.launcherPath);
  assert.equal(verifyTaskRuntime(before.runtime).ok, true);
  const vendored = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: path.join(f.root, ".pi/harness/bin/pi-harness.mjs"),
  });
  assert.equal(
    vendored.launcherPath,
    path.join(f.worktree, ".pi/harness/bin/pi-harness.mjs"),
  );
  const outside = vendorFixture(t);
  const external = resolveTaskRuntimeLauncher({
    parentRoot: f.root,
    worktree: f.worktree,
    runtimeRoot,
    baseSha: f.base,
    sourceLauncher: outside.launcher,
  });
  assert.equal(external.launcherPath, fs.realpathSync(outside.launcher));
  fs.appendFileSync(
    path.join(runtimeRoot, f.base, "core/pi/lib/local.mjs"),
    " runtime mutation",
  );
  assert.match(
    resolveTaskRuntimeLauncher({
      parentRoot: f.root,
      worktree: f.worktree,
      runtimeRoot,
      baseSha: f.base,
      sourceLauncher: f.launcher,
    }).reason,
    /clean reserved/,
  );
});
