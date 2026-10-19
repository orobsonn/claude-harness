/**
 * @description Host-neutral Git primitives for task coordination: argv-only git, ancestry,
 * clean-worktree admission (host decides which harness paths are volatile) and the
 * `merge-tree --write-tree` conflict preview used before any merge touches a worktree.
 */
import { execFileSync, spawnSync } from "node:child_process";

const SHA = /^[a-f0-9]{40}$/;

export function taskGit(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  }).trim();
}

export function isTaskAncestor(root, ancestor, descendant) {
  try {
    taskGit(root, "merge-base", "--is-ancestor", ancestor, descendant);
    return true;
  } catch {
    return false;
  }
}

/** Tracked, staged and untracked changes outside the host's volatile harness paths. */
export function pendingTaskChanges(root, isVolatile) {
  const changes = [
    ...taskGit(root, "diff", "--name-only", "-z", "--").split("\0"),
    ...taskGit(root, "diff", "--cached", "--name-only", "-z", "--").split("\0"),
  ].filter(Boolean);
  const untracked = taskGit(
    root,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  )
    .split("\0")
    .filter(Boolean);
  return [...new Set([...changes, ...untracked])].filter((name) => !isVolatile(name));
}

export function requireCleanTaskWorktree(root, isVolatile, label = "parent") {
  const pending = pendingTaskChanges(root, isVolatile);
  if (pending.length)
    throw new Error(
      `${label} worktree must be clean before task admission or integration: ${root}; pending paths: ${JSON.stringify(pending).slice(0, 2000)}. Preserve the changes and resolve this task’s reported blocker before retrying.`,
    );
}

/** Git exit 1 is a usable conflict preview, not an execution failure. */
export function taskMergePreview(root, before, after) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", "--name-only", "-z", before, after],
    { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || ![0, 1].includes(result.status))
    throw new Error(`task merge-tree failed: ${result.error?.message ?? result.stderr}`);
  const [tree, ...fields] = result.stdout.split("\0");
  const conflicts = result.status === 1 ? fields.slice(0, fields.indexOf("")) : [];
  if (!SHA.test(tree) || (result.status === 1 && !conflicts.length))
    throw new Error("task merge-tree returned an invalid preview");
  return { tree, conflicts: [...new Set(conflicts)].sort() };
}
