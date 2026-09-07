import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { quoteOrcaCommand, resolveOrcaTaskBackend } from "./task-orca.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "task-orca-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, "parent");
  fs.mkdirSync(root);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Fixture");
  git(root, "config", "user.email", "fixture@example.test");
  fs.writeFileSync(path.join(root, "base"), "base");
  git(root, "add", "."); git(root, "commit", "-qm", "base");
  const parent = {
    id: `repo::${root}`,
    repoId: "repo",
    instanceId: "parent-instance",
    path: root,
    hostId: "runtime:shared-host",
    projectId: "github:owner/repo",
    projectHostSetupId: "setup-runtime",
  };
  const state = { children: [], calls: [], failCreate: false, surface: "visible", focused: false };
  const run = async ({ args }) => {
    state.calls.push(args);
    const flag = (name) => args[args.indexOf(name) + 1];
    const action = args.slice(0, 2).join(" ");
    if (action === "worktree list") return { worktrees: state.children };
    if (action === "worktree show") {
      const selector = flag("--worktree");
      return { worktree: [parent, ...state.children].find((w) => selector === `path:${w.path}` || selector === `id:${w.id}`) };
    }
    if (action === "worktree create") {
      const cwd = path.join(dir, "child");
      git(root, "worktree", "add", "-b", "orca-prefix/task", cwd, flag("--base-branch"));
      const child = { id: `repo::${cwd}`, repoId: "repo", instanceId: "child-instance", path: cwd,
        parentWorktreeId: parent.id, comment: flag("--comment"), hostId: parent.hostId,
        projectId: parent.projectId, projectHostSetupId: parent.projectHostSetupId };
      state.children.push(child);
      if (state.failCreate) throw new Error("CLI response lost");
      return { worktree: child };
    }
    if (action === "terminal create") return { terminal: {
      handle: "term-child", tabId: "tab-child", worktreeId: flag("--worktree").slice(3), surface: state.surface,
    } };
    if (action === "terminal focus") return { focus: { handle: flag("--terminal"), tabId: "tab-child",
      worktreeId: state.children[0]?.id, navigated: state.focused } };
    throw new Error(`unexpected ${action}`);
  };
  const backend = await resolveOrcaTaskBackend({ projectRoot: root, worktreeId: parent.id }, { run });
  const entry = { task_id: "task-a", attempt_id: "attempt-a", parent_root: root,
    base_sha: git(root, "rev-parse", "HEAD"), worktree: path.join(dir, "old-placeholder"), grant: {} };
  return { dir, root, parent, state, run, backend, entry };
}

test("Orca receives exact Git base and visual parent, and returned cwd/branch bind the grant", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.backend.parent, {
    worktree_id: f.parent.id,
    instance_id: f.parent.instanceId,
    repo_id: f.parent.repoId,
    path: f.root,
    host_id: f.parent.hostId,
    project_id: f.parent.projectId,
    project_host_setup_id: f.parent.projectHostSetupId,
  });
  let persisted = 0;
  await f.backend.prepareWorktree(f.entry, () => persisted++);
  assert.ok(persisted >= 2);
  assert.equal(f.entry.grant.cwd, f.state.children[0].path);
  assert.equal(f.entry.grant.branch, "orca-prefix/task");
  const creation = f.state.calls.find((args) => args[1] === "create");
  assert.equal(creation[creation.indexOf("--base-branch") + 1], f.entry.base_sha);
  assert.equal(creation[creation.indexOf("--parent-worktree") + 1], `id:${f.parent.id}`);
  assert.equal(creation[creation.indexOf("--setup") + 1], "skip");
  assert.ok(creation.includes("--activate"));
  await f.backend.prepareWorktree(f.entry, () => persisted++);
  assert.equal(f.state.calls.filter((args) => args[0] === "worktree" && args[1] === "create").length, 1);
  f.state.children[0].instanceId = "replacement";
  await assert.rejects(f.backend.prepareWorktree(f.entry, () => {}), /replaced or moved/);
});

test("background UI adoption reveals the same terminal and keeps the official focus receipt", async (t) => {
  const f = await fixture(t);
  await f.backend.prepareWorktree(f.entry, () => {});
  f.state.surface = "background";
  f.state.focused = true;
  const handle = await f.backend.launchTerminal({ command: process.execPath, args: [], cwd: f.entry.worktree,
    worktreeId: f.entry.orca.worktree_id, instanceId: f.entry.orca.instance_id });
  assert.equal(handle.surface, "visible");
  assert.equal(handle.focus.navigated, true);
  assert.equal(handle.warning, undefined);
  assert.equal(f.state.calls.filter((args) => args[0] === "terminal" && args[1] === "create").length, 1);
  assert.equal(f.state.calls.filter((args) => args[0] === "terminal" && args[1] === "focus").length, 1);
});

test("lost create response recovers the reserved attempt without a second worktree", async (t) => {
  const f = await fixture(t);
  f.state.failCreate = true;
  await assert.rejects(f.backend.prepareWorktree(f.entry, () => {}), /response lost/);
  assert.equal(f.entry.orca.create_requested, true);
  await f.backend.prepareWorktree(f.entry, () => {});
  assert.equal(f.state.calls.filter((args) => args[1] === "create").length, 1);
  assert.equal(f.entry.orca.worktree_id, f.state.children[0].id);
});

test("uncertain creation and stale parent never silently create or target another checkout", async (t) => {
  const f = await fixture(t);
  await assert.rejects(resolveOrcaTaskBackend({ projectRoot: f.root, worktreeId: "foreign::parent" }, { run: f.run }), /does not belong/);
  f.entry.orca = { name: "reserved", comment: "reserved", parent_worktree_id: f.parent.id, repo_id: "repo", create_requested: true };
  await assert.rejects(f.backend.prepareWorktree(f.entry, () => {}), /unresolved/);
  assert.equal(f.state.calls.filter((args) => args[1] === "create").length, 0);
});

test("parent and child placement identity is pinned while absent legacy fields normalize to null", async (t) => {
  const f = await fixture(t);
  const firstParent = f.backend.parent;
  f.parent.hostId = "runtime:other-host";
  const moved = await resolveOrcaTaskBackend({ projectRoot: f.root, worktreeId: f.parent.id }, { run: f.run });
  assert.notDeepEqual(moved.parent, firstParent);
  assert.equal(moved.parent.host_id, "runtime:other-host");

  f.parent.hostId = "runtime:shared-host";
  await f.backend.prepareWorktree(f.entry, () => {});
  f.state.children[0].projectHostSetupId = "foreign-setup";
  await assert.rejects(f.backend.prepareWorktree(f.entry, () => {}), /identity mismatch/);

  delete f.parent.hostId;
  delete f.parent.projectId;
  delete f.parent.projectHostSetupId;
  const legacy = await resolveOrcaTaskBackend({ projectRoot: f.root, worktreeId: f.parent.id }, { run: f.run });
  assert.equal(legacy.parent.host_id, null);
  assert.equal(legacy.parent.project_id, null);
  assert.equal(legacy.parent.project_host_setup_id, null);
});

test("terminal handle reports actual visibility and shell arguments stay literal", async (t) => {
  const f = await fixture(t);
  await f.backend.prepareWorktree(f.entry, () => {});
  f.state.surface = "background";
  const launch = { command: process.execPath, args: ["worker with spaces", "grant'file"], cwd: f.entry.worktree,
    worktreeId: f.entry.orca.worktree_id, instanceId: f.entry.orca.instance_id };
  const handle = await f.backend.launchTerminal(launch);
  assert.equal(handle.surface, "background");
  assert.equal(handle.terminal_handle, "term-child");
  await assert.rejects(f.backend.launchTerminal({ ...launch, instanceId: "stale" }), /does not belong/);
  const marker = path.join(f.dir, "must-not-exist");
  const args = ["a b", "a'b", `$(touch ${marker})`, "`uname`", "line\nnext", "$HOME"];
  const result = execFileSync("/bin/sh", ["-c", quoteOrcaCommand(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args])], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(result), args);
  assert.equal(fs.existsSync(marker), false);
  assert.throws(() => quoteOrcaCommand("node", ["bad\0argument"]), /without NUL/);
});
