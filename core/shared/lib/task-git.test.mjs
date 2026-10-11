import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isTaskAncestor, pendingTaskChanges, requireCleanTaskWorktree, taskGit, taskMergePreview } from "./task-git.mjs";

function repo(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-git-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  taskGit(dir, "init", "-q", "-b", "main");
  taskGit(dir, "config", "user.email", "t@example.com");
  taskGit(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "base\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored/\n");
  taskGit(dir, "add", "-A");
  taskGit(dir, "commit", "-qm", "base");
  return dir;
}
const commit = (dir, file, text, message) => {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
  taskGit(dir, "add", "-A");
  taskGit(dir, "commit", "-qm", message);
  return taskGit(dir, "rev-parse", "HEAD");
};

test("clean admission ignores only the host's volatile paths and gitignored files", (t) => {
  const dir = repo(t);
  const harness = (name) => name.startsWith(".claude/plans/");
  requireCleanTaskWorktree(dir, harness);
  fs.mkdirSync(path.join(dir, ".claude/plans/.state"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude/plans/.state/x.json"), "{}");
  fs.mkdirSync(path.join(dir, "ignored"));
  fs.writeFileSync(path.join(dir, "ignored/cache"), "x");
  requireCleanTaskWorktree(dir, harness);
  fs.writeFileSync(path.join(dir, "a.txt"), "dirty\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "new\n");
  assert.deepEqual(pendingTaskChanges(dir, harness).sort(), ["a.txt", "new.txt"]);
  assert.throws(() => requireCleanTaskWorktree(dir, harness, "task a"), /task a worktree must be clean[^]*"a.txt"/);
  taskGit(dir, "add", "a.txt");
  assert.deepEqual(pendingTaskChanges(dir, harness).sort(), ["a.txt", "new.txt"], "staged changes count");
});

test("merge preview reports a clean tree or the exact conflicting paths without touching either side", (t) => {
  const dir = repo(t);
  const base = taskGit(dir, "rev-parse", "HEAD");
  taskGit(dir, "checkout", "-qb", "left");
  const left = commit(dir, "a.txt", "left\n", "left");
  const leftOnly = commit(dir, "l.txt", "l\n", "left only");
  taskGit(dir, "checkout", "-q", base);
  taskGit(dir, "checkout", "-qb", "right");
  const right = commit(dir, "a.txt", "right\n", "right");
  taskGit(dir, "checkout", "-q", base);
  taskGit(dir, "checkout", "-qb", "other");
  const other = commit(dir, "o.txt", "o\n", "other");
  const conflict = taskMergePreview(dir, leftOnly, right);
  assert.deepEqual(conflict.conflicts, ["a.txt"]);
  assert.match(conflict.tree, /^[a-f0-9]{40}$/);
  const clean = taskMergePreview(dir, leftOnly, other);
  assert.deepEqual(clean.conflicts, []);
  assert.deepEqual(taskGit(dir, "ls-tree", "--name-only", clean.tree).split("\n").sort(), [".gitignore", "a.txt", "l.txt", "o.txt"]);
  assert.equal(taskGit(dir, "rev-parse", "HEAD"), other, "preview never moves HEAD");
  assert.equal(isTaskAncestor(dir, base, left), true);
  assert.equal(isTaskAncestor(dir, left, base), false);
  assert.equal(isTaskAncestor(dir, "not-a-ref", base), false);
});
