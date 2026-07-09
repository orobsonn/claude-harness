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
import {
  runReaper,
  makeDefaultIssueClosed,
  makeDefaultPrMerged,
  makeDefaultBranchMerged,
  makeDefaultInspectWorktree,
  defaultGitWorktreeRemove,
} from "./run-reaper.mjs";

const BASE_CONFIG = {
  project: "demo",
  owner: "acme",
  repo: "demo-repo",
  projectRoot: "/srv/demo",
  stateDir: "/srv/demo/.claude/state",
  worktreeRoot: "/srv/worktrees",
  homeDir: "/home/harness",
  projects: [
    { project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/.claude/state" },
  ],
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

test("[integration HIGH closed] run-reaper wires defaultPrOpen (--state open, raw spawn seam) distinct from prExists", () => {
  const config = { ...BASE_CONFIG };

  let capturedReaperOpts;
  const fakeReaperLogic = (opts) => {
    capturedReaperOpts = opts;
  };

  const spawnCalls = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    if (cmd === "gh" && args.includes("--state") && args.includes("open")) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 7, headRefName: "harness/42", url: "https://github.com/acme/demo-repo/pull/7", body: "" },
        ]),
      };
    }
    return { status: 0, stdout: "[]" };
  };

  runReaper(config, {
    reaper: fakeReaperLogic,
    spawn: fakeSpawn,
  });

  assert.equal(
    typeof capturedReaperOpts.prOpen,
    "function",
    "runReaper must wire a prOpen seam into the reaper logic's opts (defaultPrOpen)"
  );

  assert.notEqual(
    capturedReaperOpts.prOpen,
    capturedReaperOpts.prExists,
    "prOpen must be a DISTINCT function from prExists — an open-only query, never the closed-inclusive one"
  );

  const result = capturedReaperOpts.prOpen(42, "demo");

  assert.equal(result, true, "prOpen(42, 'demo') must be true for the harness/42 branch PR");

  const openCall = spawnCalls.find(
    (call) =>
      call.cmd === "gh" &&
      call.args.includes("pr") &&
      call.args.includes("list") &&
      call.args.includes("--state") &&
      call.args.includes("open")
  );
  assert.notEqual(openCall, undefined, "prOpen must issue a gh pr list --state open call via the raw spawn seam");
  assert.ok(
    !openCall.args.includes("--head"),
    "prOpen's gh call must NOT scope by --head — it must sweep every open PR to also catch body-links"
  );
  const limitFlagIndex = openCall.args.indexOf("--limit");
  assert.notEqual(limitFlagIndex, -1, "prOpen's gh call must cap the sweep with --limit 100");
  assert.notEqual(openCall.args[limitFlagIndex + 1], undefined, "--limit must carry a value");
  const jsonFlagIndex = openCall.args.indexOf("--json");
  assert.notEqual(jsonFlagIndex, -1, "prOpen's gh call must request --json fields");
  assert.ok(
    openCall.args[jsonFlagIndex + 1].includes("body"),
    "prOpen's --json field list must include body (needed for body-link recognition)"
  );
});

test("[integration HIGH closed] run-reaper's prOpen recognizes a body-link Closes/Fixes/Resolves/Refs on a typed branch", () => {
  const config = { ...BASE_CONFIG };

  let capturedReaperOpts;
  const fakeReaperLogic = (opts) => {
    capturedReaperOpts = opts;
  };

  const fakeSpawn = (cmd, args) => {
    if (cmd === "gh" && args.includes("--state") && args.includes("open")) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 7, headRefName: "feat/x", url: "https://github.com/acme/demo-repo/pull/7", body: "Closes #42" },
        ]),
      };
    }
    return { status: 0, stdout: "[]" };
  };

  runReaper(config, {
    reaper: fakeReaperLogic,
    spawn: fakeSpawn,
  });

  assert.equal(
    typeof capturedReaperOpts.prOpen,
    "function",
    "opts.prOpen must be a defined function before invoking it"
  );

  const result = capturedReaperOpts.prOpen(42, "demo");

  assert.equal(
    result,
    true,
    "prOpen(42, 'demo') must recognize the body-link (Closes #42) even though the PR's head is not harness/42"
  );
});

test("run-reaper's prOpen FAILS OPEN on a gh error — returns true (skip) so the sweep never closes a live PR's topic during a gh outage", () => {
  const config = { ...BASE_CONFIG };

  let capturedReaperOpts;
  const fakeReaperLogic = (opts) => {
    capturedReaperOpts = opts;
  };

  const fakeSpawn = () => ({ status: 1, stdout: "" });

  runReaper(config, {
    reaper: fakeReaperLogic,
    spawn: fakeSpawn,
  });

  assert.equal(
    typeof capturedReaperOpts.prOpen,
    "function",
    "opts.prOpen must be a defined function before invoking it"
  );

  const result = capturedReaperOpts.prOpen(42, "demo");

  assert.equal(
    result,
    true,
    "a gh error must make prOpen(42, 'demo') assume the PR is OPEN (skip the close) — never false, which would close a live topic"
  );
});

/**
 * @description Builds an in-memory fake spawn (spawnSync shape) that records every call's
 * {cmd, args, opts} into `calls` and delegates the response to the given handler. Shared across
 * the completed-sweep tri-state probe tests below (3+ call sites) so each test asserts on the
 * recorded argv without re-declaring the same recording boilerplate.
 * @param {(cmd: string, args: string[], opts: object) => {status: number, stdout: string, error?: *}} handler
 * @returns {{ spawn: (cmd: string, args: string[], opts: object) => object, calls: Array<{cmd: string, args: string[], opts: object}> }}
 */
function makeRecordingSpawn(handler) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return handler(cmd, args, opts);
  };
  return { spawn, calls };
}

test("[integration HIGH closed] run-reaper wires the four completed-sweep tri-state probes (issueClosed, prMerged, branchMerged, inspectWorktree) plus gitWorktreeRemove into the reaper logic's opts", () => {
  const config = { ...BASE_CONFIG };

  let capturedOpts;
  const fakeReaperLogic = (opts) => {
    capturedOpts = opts;
    return [];
  };

  runReaper(config, {
    reaper: fakeReaperLogic,
    listWorktrees: () => [],
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.equal(
    typeof capturedOpts.issueClosed,
    "function",
    "runReaper must wire an issueClosed seam into the reaper logic's opts"
  );
  assert.equal(
    typeof capturedOpts.prMerged,
    "function",
    "runReaper must wire a prMerged seam into the reaper logic's opts"
  );
  assert.equal(
    typeof capturedOpts.branchMerged,
    "function",
    "runReaper must wire a branchMerged seam into the reaper logic's opts"
  );
  assert.equal(
    typeof capturedOpts.inspectWorktree,
    "function",
    "runReaper must wire an inspectWorktree seam into the reaper logic's opts"
  );
  assert.equal(
    typeof capturedOpts.gitWorktreeRemove,
    "function",
    "runReaper must wire a gitWorktreeRemove seam into the reaper logic's opts"
  );
});

test("makeDefaultBranchMerged maps git merge-base --is-ancestor exit codes to true/false/null — exit 128 (or a spawn throw) must be null, NEVER false, so an unrelated-history error never authorizes a branch delete", () => {
  const projectRoot = "/srv/demo";
  const branch = "harness/161";

  const rec128 = makeRecordingSpawn(() => ({ status: 128, stdout: "" }));
  const result128 = makeDefaultBranchMerged(rec128.spawn)(branch, projectRoot);
  assert.equal(result128, null, "exit 128 (unrelated histories / unknown) must be null, not false");
  assert.equal(rec128.calls.length, 1);
  assert.deepEqual(
    rec128.calls[0].args,
    ["-C", projectRoot, "merge-base", "--is-ancestor", branch, "main"],
    "branchMerged must run git merge-base --is-ancestor <branch> main scoped to -C <projectRoot>"
  );

  const rec0 = makeRecordingSpawn(() => ({ status: 0, stdout: "" }));
  assert.equal(
    makeDefaultBranchMerged(rec0.spawn)(branch, projectRoot),
    true,
    "exit 0 -> true (branch is an ancestor of main)"
  );

  const rec1 = makeRecordingSpawn(() => ({ status: 1, stdout: "" }));
  assert.equal(
    makeDefaultBranchMerged(rec1.spawn)(branch, projectRoot),
    false,
    "exit 1 -> false (branch is not an ancestor of main)"
  );

  const spawnThrow = () => {
    throw new Error("spawn ENOENT");
  };
  assert.equal(
    makeDefaultBranchMerged(spawnThrow)(branch, projectRoot),
    null,
    "a spawn throw must be null, never false"
  );
});

test("makeDefaultPrMerged maps gh pr list --state merged to true/false/null via the raw spawn seam (never the normalized gh/ghExec seam, whose [] is ambiguous between a gh error and a genuine empty result)", () => {
  const owner = "owner";
  const repo = "repo";
  const issueNumber = 161;

  const recMerged = makeRecordingSpawn(() => ({ status: 0, stdout: '[{"number":7}]' }));
  const prMergedTrue = makeDefaultPrMerged(recMerged.spawn, owner, repo);
  assert.equal(prMergedTrue(issueNumber), true, "a non-empty array from gh pr list --state merged must be true");

  assert.equal(recMerged.calls.length, 1);
  const args = recMerged.calls[0].args;
  assert.ok(args.includes("pr"), "argv must include pr");
  assert.ok(args.includes("list"), "argv must include list");
  assert.ok(args.includes("--head"), "argv must include --head");
  assert.ok(args.includes(`harness/${issueNumber}`), "argv must scope --head to harness/<issueNumber>");
  assert.ok(args.includes("--state"), "argv must include --state");
  assert.ok(args.includes("merged"), "argv must scope --state to merged");

  const recEmpty = makeRecordingSpawn(() => ({ status: 0, stdout: "[]" }));
  const prMergedFalse = makeDefaultPrMerged(recEmpty.spawn, owner, repo);
  assert.equal(prMergedFalse(issueNumber), false, "an empty array from a successful gh call must be false");

  const recGhError = makeRecordingSpawn(() => ({ status: 1, stdout: "" }));
  const prMergedNull = makeDefaultPrMerged(recGhError.spawn, owner, repo);
  assert.equal(
    prMergedNull(issueNumber),
    null,
    "a gh error (non-zero status) must be null, never false — a gh outage must never be read as not-merged"
  );
});

test("run-reaper notifies reaper-orphan-cleaned for a completed-cleaned action, scoped to the action's own project and issue", () => {
  const config = { ...BASE_CONFIG };

  const fakeReaperLogic = () => [{ action: "completed-cleaned", project: "demo-project", issueNumber: 161 }];

  const notifyCalls = [];
  const fakeNotify = (payload) => {
    notifyCalls.push(payload);
  };

  runReaper(config, {
    reaper: fakeReaperLogic,
    listWorktrees: () => [],
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    runLock: { release: () => {} },
    counter: { read: () => 0 },
    notify: fakeNotify,
  });

  assert.equal(notifyCalls.length, 1, "notify must be called exactly once for the single completed-cleaned action");
  assert.deepEqual(
    notifyCalls[0],
    { type: "reaper-orphan-cleaned", project: "demo-project", issue: 161 },
    "a completed-cleaned action must notify type reaper-orphan-cleaned scoped to the action's own project/issue"
  );
});

test("defaultGitWorktreeRemove's argv includes --force only when opts.force is true; the two-arg contract stays unchanged when opts is omitted", () => {
  const worktreePath = "/srv/worktrees/harness-demo-161";
  const projectRoot = "/srv/demo";

  const recForce = makeRecordingSpawn(() => ({ status: 0, stdout: "" }));
  defaultGitWorktreeRemove(worktreePath, projectRoot, { force: true }, recForce.spawn);

  assert.equal(recForce.calls.length, 1);
  const forceArgs = recForce.calls[0].args;
  assert.ok(forceArgs.includes("worktree"), "argv must include worktree");
  assert.ok(forceArgs.includes("remove"), "argv must include remove");
  assert.ok(forceArgs.includes("--force"), "opts.force === true must add --force to the argv");
  assert.ok(forceArgs.includes(worktreePath), "the argv must include the worktree path");

  const recNoForce = makeRecordingSpawn(() => ({ status: 0, stdout: "" }));
  defaultGitWorktreeRemove(worktreePath, projectRoot, undefined, recNoForce.spawn);

  assert.equal(recNoForce.calls.length, 1);
  const noForceArgs = recNoForce.calls[0].args;
  assert.ok(
    !noForceArgs.includes("--force"),
    "an omitted (undefined) opts must NOT add --force — the two-arg contract is unchanged"
  );
});

test("makeDefaultInspectWorktree parses git log --oneline main..<branch> into unmergedCommits and git status --porcelain into dirtyPaths — a rename of either field throws into reaper()'s per-worktree swallowing try/catch and silently blocks every prune", () => {
  const worktree = {
    branch: "harness/161",
    projectRoot: "/srv/demo",
    worktreePath: "/srv/worktrees/harness-demo-161",
  };

  const recOk = makeRecordingSpawn((cmd, args) => {
    if (cmd === "git" && args.includes("log")) {
      return { status: 0, stdout: "abc123 wip\ndef456 more\n" };
    }
    if (cmd === "git" && args.includes("status")) {
      return { status: 0, stdout: " M core/vps/reaper.mjs\n" };
    }
    return { status: 1, stdout: "" };
  });

  const inspectOk = makeDefaultInspectWorktree(recOk.spawn);
  const inspection = inspectOk(worktree);

  assert.deepEqual(
    inspection.unmergedCommits,
    ["abc123 wip", "def456 more"],
    "unmergedCommits must be the git log --oneline output split on newlines with empty lines dropped"
  );
  assert.deepEqual(
    inspection.dirtyPaths,
    [" M core/vps/reaper.mjs"],
    "dirtyPaths must be the git status --porcelain output split on newlines with empty lines dropped"
  );

  const rec128 = makeRecordingSpawn((cmd, args) => {
    if (cmd === "git" && args.includes("log")) return { status: 128, stdout: "" };
    return { status: 0, stdout: "" };
  });
  assert.equal(
    makeDefaultInspectWorktree(rec128.spawn)(worktree),
    null,
    "a non-zero status from the git log call must be null"
  );

  const spawnThrow = () => {
    throw new Error("spawn ENOENT");
  };
  assert.equal(makeDefaultInspectWorktree(spawnThrow)(worktree), null, "a spawn throw must be null");
});

test("makeDefaultIssueClosed maps gh issue view --json state to true/false/null — a gh error or unparseable stdout must be null, never a guess", () => {
  const owner = "owner";
  const repo = "repo";
  const issueNumber = 161;

  const recClosed = makeRecordingSpawn(() => ({ status: 0, stdout: '{"state":"CLOSED"}' }));
  const issueClosedTrue = makeDefaultIssueClosed(recClosed.spawn, owner, repo);
  assert.equal(issueClosedTrue(issueNumber), true, 'state "CLOSED" must be true');

  assert.equal(recClosed.calls.length, 1);
  const args = recClosed.calls[0].args;
  assert.ok(args.includes("issue"), "argv must include issue");
  assert.ok(args.includes("view"), "argv must include view");
  assert.ok(args.includes(String(issueNumber)), "argv must include the issue number");
  assert.ok(args.includes("--json"), "argv must include --json");
  assert.ok(args.includes("state"), "argv must request the state field");

  const recOpen = makeRecordingSpawn(() => ({ status: 0, stdout: '{"state":"OPEN"}' }));
  assert.equal(
    makeDefaultIssueClosed(recOpen.spawn, owner, repo)(issueNumber),
    false,
    'state "OPEN" must be false'
  );

  const recGhError = makeRecordingSpawn(() => ({ status: 1, stdout: "" }));
  assert.equal(
    makeDefaultIssueClosed(recGhError.spawn, owner, repo)(issueNumber),
    null,
    "a gh error (non-zero status) must be null"
  );

  const recUnparseable = makeRecordingSpawn(() => ({ status: 0, stdout: "not json" }));
  assert.equal(
    makeDefaultIssueClosed(recUnparseable.spawn, owner, repo)(issueNumber),
    null,
    "unparseable stdout must be null"
  );
});
