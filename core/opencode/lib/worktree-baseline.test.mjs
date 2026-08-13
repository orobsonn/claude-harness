/** @description Dispatch-time worktree baseline preserves exact hand attribution. */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapshotWorktreeBaseline, pathsChangedSinceBaseline } from "./worktree-baseline.mjs";

test("unchanged dirty files from before dispatch are excluded while a later hand write remains attributed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-worktree-baseline-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const value = 1;\n");
    git("add", "src/a.ts");
    git("commit", "-m", "baseline");

    fs.writeFileSync(path.join(root, "MEMORY.md"), "vendored before dispatch\n");
    const baseline = snapshotWorktreeBaseline(root);
    assert.equal(baseline?.version, 1);

    fs.writeFileSync(path.join(root, "src", "a.ts"), "export const value = 2;\n");
    assert.deepEqual(pathsChangedSinceBaseline(root, baseline), ["src/a.ts"]);

    fs.writeFileSync(path.join(root, "MEMORY.md"), "mutated by hand\n");
    assert.deepEqual(pathsChangedSinceBaseline(root, baseline).sort(), ["MEMORY.md", "src/a.ts"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("baseline attributes deletion and permission changes to a pre-existing dirty path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-worktree-baseline-fingerprint-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
    git("add", "tracked.txt");
    git("commit", "-m", "baseline");

    fs.writeFileSync(path.join(root, "MEMORY.md"), "pre-existing\n", { mode: 0o644 });
    const baseline = snapshotWorktreeBaseline(root);
    assert.equal(baseline?.version, 1);

    fs.chmodSync(path.join(root, "MEMORY.md"), 0o755);
    assert.deepEqual(pathsChangedSinceBaseline(root, baseline), ["MEMORY.md"]);

    fs.unlinkSync(path.join(root, "MEMORY.md"));
    assert.deepEqual(pathsChangedSinceBaseline(root, baseline), ["MEMORY.md"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("baseline suppresses an unchanged pre-existing unreadable path but attributes a later change", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-worktree-baseline-opaque-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const opaque = path.join(root, "operator-owned.txt");
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
    git("add", "tracked.txt");
    git("commit", "-m", "baseline");

    fs.writeFileSync(opaque, "pre-existing operator data\n", { mode: 0o600 });
    fs.chmodSync(opaque, 0o000);
    const baseline = snapshotWorktreeBaseline(root);
    assert.deepEqual(baseline?.entries.map((entry) => entry.path), ["operator-owned.txt"]);
    assert.equal(baseline?.entries[0]?.fingerprint.kind, "opaque");
    assert.deepEqual(pathsChangedSinceBaseline(root, baseline), []);

    fs.chmodSync(opaque, 0o600);
    fs.writeFileSync(opaque, "changed after dispatch\n");
    fs.chmodSync(opaque, 0o000);
    assert.deepEqual(pathsChangedSinceBaseline(root, baseline), ["operator-owned.txt"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a malformed optional baseline never suppresses current dirty paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-worktree-baseline-invalid-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  try {
    git("init");
    git("config", "user.email", "harness@example.invalid");
    git("config", "user.name", "Harness Test");
    fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
    git("add", "tracked.txt");
    git("commit", "-m", "baseline");
    fs.writeFileSync(path.join(root, "MEMORY.md"), "pre-existing\n");

    assert.deepEqual(pathsChangedSinceBaseline(root, { version: 99, entries: [] }), ["MEMORY.md"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
