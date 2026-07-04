/**
 * @description Pinned assertions for the VPS cron harness COMPOSITION ROOTS (task-9 glue-3):
 * run-cron-a.mjs (runCronA + loadConfig), run-cron-b.mjs (runCronB), run-reaper.mjs (runReaper).
 * Each root reads a per-project config and WIRES the real seams around the already-built LOGIC
 * functions (cronASelect, dispatch, cronB, reaper, listWorktrees, buildScopedEnvFromDisk). Every
 * assertion here observes the WIRING through injected fakes — never a real git/gh/tmux/fs call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runCronA, loadConfig } from "./run-cron-a.mjs";
import { runCronB } from "./run-cron-b.mjs";
import { runReaper } from "./run-reaper.mjs";

const BASE_CONFIG = {
  project: "demo",
  owner: "acme",
  repo: "demo-repo",
  projectRoot: "/srv/demo",
  stateDir: "/srv/demo/.claude/state",
  worktreeRoot: "/srv/worktrees",
  homeDir: "/home/harness",
};

test("[integration HIGH closed] run-cron-a wires buildScopedEnvFromDisk (not the broken pure buildScopedEnv) into dispatch", () => {
  const config = { ...BASE_CONFIG };

  let capturedDispatchSeam;
  const fakeCronASelect = (opts) => {
    capturedDispatchSeam = opts.dispatch;
    return { ok: true, dispatched: false };
  };

  const fromDiskCalls = [];
  const fakeBuildScopedEnvFromDisk = (project, opts) => {
    fromDiskCalls.push({ project, opts });
    return { MARKER: "from-disk" };
  };

  let pureBuildScopedEnvCalled = false;
  const fakePureBuildScopedEnv = () => {
    pureBuildScopedEnvCalled = true;
    return {};
  };

  let dispatchOptsSeen;
  const fakeDispatchLogic = (issue, opts) => {
    dispatchOptsSeen = opts;
    // Mirrors real cron-a-dispatch.mjs: buildScopedEnv(project, { stateDir, projectRoot }).
    opts.buildScopedEnv(opts.project, { stateDir: opts.stateDir, projectRoot: opts.projectRoot });
    return { ok: true };
  };

  runCronA(config, {
    cronASelect: fakeCronASelect,
    dispatch: fakeDispatchLogic,
    buildScopedEnvFromDisk: fakeBuildScopedEnvFromDisk,
    buildScopedEnv: fakePureBuildScopedEnv,
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    runLock: { acquire: () => ({ acquired: false }), release: () => {}, register: () => {} },
    spawn: () => {},
    counter: { increment: () => {}, read: () => 0 },
  });

  assert.equal(
    typeof capturedDispatchSeam,
    "function",
    "runCronA must pass a dispatch seam to cronASelect's opts.dispatch"
  );

  capturedDispatchSeam({ number: 1, body: "issue body" }, { acquireTs: 12345 });

  assert.equal(dispatchOptsSeen.project, config.project);
  assert.equal(dispatchOptsSeen.stateDir, config.stateDir);
  assert.equal(dispatchOptsSeen.projectRoot, config.projectRoot);
  assert.equal(
    fromDiskCalls.length,
    1,
    "the dispatch wiring's buildScopedEnv must be the buildScopedEnvFromDisk adapter"
  );
  assert.equal(fromDiskCalls[0].opts.projectRoot, config.projectRoot);
  assert.equal(fromDiskCalls[0].opts.homeDir, config.homeDir);
  assert.equal(
    pureBuildScopedEnvCalled,
    false,
    "the broken pure buildScopedEnv (which returns {} given {stateDir, projectRoot}) must never be called"
  );
});

test("[security UNSAFE closed] run-cron-b enforces a non-empty harness author gate", () => {
  const configWithoutAuthor = { ...BASE_CONFIG };

  let capturedOptsDefaulted;
  const fakeCronBDefault = (opts) => {
    capturedOptsDefaulted = opts;
  };

  runCronB(configWithoutAuthor, {
    cronB: fakeCronBDefault,
    getAuthenticatedGhUser: () => "harness-bot",
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    parseVerdictBlock: () => ({ status: "CLEAN" }),
    alreadyReviewed: () => false,
    recordReviewed: () => {},
  });

  assert.equal(
    capturedOptsDefaulted.harnessAuthorLogin,
    "harness-bot",
    "config without harnessAuthorLogin must default to the authenticated gh user — never unset/empty"
  );

  const configWithAuthor = { ...BASE_CONFIG, harnessAuthorLogin: "my-bot" };

  let capturedOptsConfigured;
  const fakeCronBConfigured = (opts) => {
    capturedOptsConfigured = opts;
  };

  runCronB(configWithAuthor, {
    cronB: fakeCronBConfigured,
    getAuthenticatedGhUser: () => "harness-bot",
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    parseVerdictBlock: () => ({ status: "CLEAN" }),
    alreadyReviewed: () => false,
    recordReviewed: () => {},
  });

  assert.equal(
    capturedOptsConfigured.harnessAuthorLogin,
    "my-bot",
    "config-supplied harnessAuthorLogin must win over the authenticated gh user"
  );
});

test("run-reaper wires listWorktrees + the reaper seams over config's projects", () => {
  const config = {
    ...BASE_CONFIG,
    projects: [
      { project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/.claude/state" },
      { project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/.claude/state" },
    ],
  };

  let capturedListWorktreesSeam;
  const fakeReaperLogic = (opts) => {
    capturedListWorktreesSeam = opts.listWorktrees;
  };

  const listWorktreesCalls = [];
  const fakeListWorktreesProducer = (opts) => {
    listWorktreesCalls.push(opts);
    return [{ project: "demo", worktreePath: "/srv/worktrees/harness-demo-1" }];
  };

  runReaper(config, {
    reaper: fakeReaperLogic,
    listWorktrees: fakeListWorktreesProducer,
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.equal(
    typeof capturedListWorktreesSeam,
    "function",
    "runReaper must pass a listWorktrees seam to the reaper logic's opts.listWorktrees"
  );

  const result = capturedListWorktreesSeam();

  assert.equal(
    listWorktreesCalls.length,
    1,
    "the wired listWorktrees seam must delegate to the injected listWorktrees producer"
  );
  assert.deepEqual(
    listWorktreesCalls[0].projects,
    config.projects,
    "the producer must be invoked over config's configured projects"
  );
  assert.deepEqual(result, [{ project: "demo", worktreePath: "/srv/worktrees/harness-demo-1" }]);
});

test("loadConfig throws naming the missing required field, and normalizes a complete config", () => {
  const incomplete = {
    project: "demo",
    owner: "acme",
    repo: "demo-repo",
    stateDir: "/srv/demo/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    // projectRoot deliberately missing
  };

  assert.throws(
    () => loadConfig(incomplete),
    /projectRoot/,
    "loadConfig must throw an error naming the missing required field"
  );

  const complete = { ...BASE_CONFIG };
  const normalized = loadConfig(complete);

  assert.equal(normalized.project, complete.project);
  assert.equal(normalized.owner, complete.owner);
  assert.equal(normalized.repo, complete.repo);
  assert.equal(normalized.projectRoot, complete.projectRoot);
  assert.equal(normalized.stateDir, complete.stateDir);
  assert.equal(normalized.worktreeRoot, complete.worktreeRoot);
  assert.equal(normalized.homeDir, complete.homeDir);
});

test("run-cron-a builds the gh seam scoped to config.owner/config.repo (--repo owner/repo)", () => {
  const config = { ...BASE_CONFIG };

  let capturedGh;
  const fakeCronASelect = (opts) => {
    capturedGh = opts.gh;
    return { ok: true, dispatched: false };
  };

  const ghExecCalls = [];
  const fakeGhExec = (args) => {
    ghExecCalls.push(args);
    return { ok: true };
  };

  runCronA(config, {
    cronASelect: fakeCronASelect,
    dispatch: () => ({ ok: true }),
    buildScopedEnvFromDisk: () => ({}),
    ghExec: fakeGhExec,
    runLock: { acquire: () => ({ acquired: false }), release: () => {}, register: () => {} },
    spawn: () => {},
    counter: { increment: () => {}, read: () => 0 },
  });

  assert.equal(
    typeof capturedGh,
    "function",
    "runCronA must pass a gh seam to cronASelect's opts.gh"
  );

  capturedGh(["issue", "list", "--label", "harness:ready"]);

  assert.equal(ghExecCalls.length, 1);
  const args = ghExecCalls[0];
  const repoFlagIndex = args.indexOf("--repo");
  assert.notEqual(repoFlagIndex, -1, "the gh seam must scope every call with --repo <owner>/<repo>");
  assert.equal(
    args[repoFlagIndex + 1],
    `${config.owner}/${config.repo}`,
    "the --repo value must be the configured owner/repo — never the wrong project's repo"
  );
});
