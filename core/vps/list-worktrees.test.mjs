/**
 * @description Contract tests for list-worktrees.mjs — the real `listWorktrees()` producer that
 * reaper.mjs consumes (reaper.test.mjs injects fake entries directly; this is the seam that builds
 * those entries for real, by running `git worktree list --porcelain` per configured project and
 * reading each run-lock holder). Every dependency (runGitWorktreeList, readHolder) is an injected
 * fake — no real git/fs is ever touched. Assertions are made exclusively on the returned array of
 * entries (the observable), never on internal parsing state.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { listWorktrees } from "./list-worktrees.mjs";

/** @description Builds a fake `git worktree list --porcelain` stdout blob for one project. */
function porcelain(primaryPath, harnessEntries = []) {
  let out = `worktree ${primaryPath}\nHEAD aaaaaaa\nbranch refs/heads/main\n\n`;
  for (const { path, branch } of harnessEntries) {
    out += `worktree ${path}\nHEAD bbbbbbb\nbranch refs/heads/${branch}\n\n`;
  }
  return out;
}

/** @description Fake `runGitWorktreeList(projectRoot)` seam backed by a projectRoot -> stdout map. */
function makeFakeRunGitWorktreeList(stdoutByProjectRoot) {
  return (projectRoot) => stdoutByProjectRoot[projectRoot];
}

/** @description Fake `readHolder({stateDir})` seam backed by a stateDir -> holder map. */
function makeFakeReadHolder(holderByStateDir) {
  return ({ stateDir }) => holderByStateDir[stateDir] ?? null;
}

test("listWorktrees: for one project, returns only the harness/* worktrees (excludes the primary/main worktree), with correct branch/issueNumber/worktreePath/project/projectRoot/stateDir", () => {
  const project = {
    project: "demo-project",
    projectRoot: "/root/dev/demo-project",
    stateDir: "/root/dev/demo-project/.claude/state",
  };

  const stdout = porcelain("/root/dev/demo-project", [
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-42", branch: "harness/42" },
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-7", branch: "harness/7" },
  ]);

  const runGitWorktreeList = makeFakeRunGitWorktreeList({
    "/root/dev/demo-project": stdout,
  });
  const readHolder = makeFakeReadHolder({});

  const entries = listWorktrees({ projects: [project], runGitWorktreeList, readHolder });

  assert.equal(entries.length, 2, "the primary/main worktree must be excluded, leaving exactly 2 harness entries");

  const e42 = entries.find((e) => e.issueNumber === 42);
  const e7 = entries.find((e) => e.issueNumber === 7);

  assert.ok(e42, "an entry for harness/42 must be present");
  assert.equal(e42.branch, "harness/42");
  assert.equal(e42.worktreePath, "/root/dev/demo-project/.worktrees/harness-demo-project-42");
  assert.equal(e42.project, "demo-project");
  assert.equal(e42.projectRoot, "/root/dev/demo-project");
  assert.equal(e42.stateDir, "/root/dev/demo-project/.claude/state");

  assert.ok(e7, "an entry for harness/7 must be present");
  assert.equal(e7.branch, "harness/7");
  assert.equal(e7.worktreePath, "/root/dev/demo-project/.worktrees/harness-demo-project-7");
  assert.equal(e7.project, "demo-project");
  assert.equal(e7.projectRoot, "/root/dev/demo-project");
  assert.equal(e7.stateDir, "/root/dev/demo-project/.claude/state");
});

test("listWorktrees: when the project holder's tmux_session_id matches an entry's own expected session, that entry's holder deep-equals the shared project-level holder object (the live run's own worktree keeps the holder)", () => {
  const project = {
    project: "demo-project",
    projectRoot: "/root/dev/demo-project",
    stateDir: "/root/dev/demo-project/.claude/state",
  };

  const stdout = porcelain("/root/dev/demo-project", [
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-42", branch: "harness/42" },
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-7", branch: "harness/7" },
  ]);

  const holder = { pid: 999, acquire_ts: 1000, tmux_session_id: "harness-demo-project-42" };

  const runGitWorktreeList = makeFakeRunGitWorktreeList({
    "/root/dev/demo-project": stdout,
  });
  const readHolder = makeFakeReadHolder({
    "/root/dev/demo-project/.claude/state": holder,
  });

  const entries = listWorktrees({ projects: [project], runGitWorktreeList, readHolder });

  const e42 = entries.find((e) => e.issueNumber === 42);
  assert.ok(e42, "an entry for harness/42 must be present");
  assert.deepEqual(
    e42.holder,
    holder,
    "harness/42's own expected session matches the lock's tmux_session_id, so it must keep the shared project holder"
  );
});

test("listWorktrees: when the project holder's tmux_session_id does NOT match an entry's own expected session, that entry's holder is null (the shared project holder must not be blindly assigned to a worktree it doesn't belong to)", () => {
  const project = {
    project: "demo-project",
    projectRoot: "/root/dev/demo-project",
    stateDir: "/root/dev/demo-project/.claude/state",
  };

  const stdout = porcelain("/root/dev/demo-project", [
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-42", branch: "harness/42" },
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-7", branch: "harness/7" },
  ]);

  const holder = { pid: 999, acquire_ts: 1000, tmux_session_id: "harness-demo-project-42" };

  const runGitWorktreeList = makeFakeRunGitWorktreeList({
    "/root/dev/demo-project": stdout,
  });
  const readHolder = makeFakeReadHolder({
    "/root/dev/demo-project/.claude/state": holder,
  });

  const entries = listWorktrees({ projects: [project], runGitWorktreeList, readHolder });

  const e7 = entries.find((e) => e.issueNumber === 7);
  assert.ok(e7, "an entry for harness/7 must be present");
  assert.equal(
    e7.holder,
    null,
    "harness/7's own expected session 'harness-demo-project-7' does not match the lock's tmux_session_id, so its holder must be null"
  );
});

test("listWorktrees: when the project holder has NO tmux_session_id key at all (unregistered — the acquire→register window), EVERY entry retains that holder unchanged", () => {
  const project = {
    project: "demo-project",
    projectRoot: "/root/dev/demo-project",
    stateDir: "/root/dev/demo-project/.claude/state",
  };

  const stdout = porcelain("/root/dev/demo-project", [
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-42", branch: "harness/42" },
    { path: "/root/dev/demo-project/.worktrees/harness-demo-project-7", branch: "harness/7" },
  ]);

  const holder = { pid: 999, acquire_ts: 1000 };

  const runGitWorktreeList = makeFakeRunGitWorktreeList({
    "/root/dev/demo-project": stdout,
  });
  const readHolder = makeFakeReadHolder({
    "/root/dev/demo-project/.claude/state": holder,
  });

  const entries = listWorktrees({ projects: [project], runGitWorktreeList, readHolder });

  assert.equal(entries.length, 2);
  for (const entry of entries) {
    assert.deepEqual(
      entry.holder,
      holder,
      `entry for issue ${entry.issueNumber} must retain the unregistered holder unchanged (never nulled)`
    );
    assert.notEqual(entry.holder, null, `entry for issue ${entry.issueNumber} must not have a null holder`);
  }
});

test("listWorktrees: sweeps MULTIPLE configured projects in a single call, returning entries from BOTH (one shared sweep feeding the shared reaper cron)", () => {
  const projectX = {
    project: "project-x",
    projectRoot: "/root/dev/project-x",
    stateDir: "/root/dev/project-x/.claude/state",
  };
  const projectY = {
    project: "project-y",
    projectRoot: "/root/dev/project-y",
    stateDir: "/root/dev/project-y/.claude/state",
  };

  const stdoutX = porcelain("/root/dev/project-x", [
    { path: "/root/dev/project-x/.worktrees/harness-project-x-100", branch: "harness/100" },
  ]);
  const stdoutY = porcelain("/root/dev/project-y", [
    { path: "/root/dev/project-y/.worktrees/harness-project-y-200", branch: "harness/200" },
  ]);

  const runGitWorktreeList = makeFakeRunGitWorktreeList({
    "/root/dev/project-x": stdoutX,
    "/root/dev/project-y": stdoutY,
  });
  const readHolder = makeFakeReadHolder({
    "/root/dev/project-x/.claude/state": { pid: 1, acquire_ts: 1 },
    "/root/dev/project-y/.claude/state": { pid: 2, acquire_ts: 2 },
  });

  const entries = listWorktrees({ projects: [projectX, projectY], runGitWorktreeList, readHolder });

  assert.ok(
    entries.some((e) => e.project === "project-x" && e.issueNumber === 100),
    "project-x's harness worktree must be present in the shared sweep"
  );
  assert.ok(
    entries.some((e) => e.project === "project-y" && e.issueNumber === 200),
    "project-y's harness worktree must ALSO be present in the SAME shared sweep"
  );
});

test("listWorktrees: a project whose porcelain output has ONLY the primary worktree contributes no entries, and does not throw", () => {
  const project = {
    project: "empty-project",
    projectRoot: "/root/dev/empty-project",
    stateDir: "/root/dev/empty-project/.claude/state",
  };

  const stdout = porcelain("/root/dev/empty-project", []);

  const runGitWorktreeList = makeFakeRunGitWorktreeList({
    "/root/dev/empty-project": stdout,
  });
  const readHolder = makeFakeReadHolder({});

  let entries;
  assert.doesNotThrow(() => {
    entries = listWorktrees({ projects: [project], runGitWorktreeList, readHolder });
  });

  assert.deepEqual(entries, [], "a primary-only project must contribute zero entries");
});
