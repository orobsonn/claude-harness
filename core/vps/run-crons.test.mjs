/**
 * @description Pinned assertions for the VPS cron harness COMPOSITION ROOTS (task-9 glue-3):
 * run-cron-a.mjs (runCronA + loadConfig), run-cron-b.mjs (runCronB), run-reaper.mjs (runReaper).
 * Each root reads a per-project config and WIRES the real seams around the already-built LOGIC
 * functions (cronASelect, dispatch, cronB, reaper, listWorktrees, buildScopedEnvFromDisk). Every
 * assertion here observes the WIRING through injected fakes — never a real git/gh/tmux/fs call.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCronA, loadConfig } from "./run-cron-a.mjs";
import { runCronB } from "./run-cron-b.mjs";
import {
  runReaper,
  mainReaper,
  defaultListObsRuns,
  unlinkRunFiles,
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
  assert.equal(dispatchOptsSeen.runtime, "opencode", "runCronA threads config.runtime into dispatch opts as runtime (default opencode when omitted)");
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

// -------------------------------------------------------------------------------------------
// Retention sweep composition-root wiring (#ac-1.1, #ac-1.2, #ac-1.4, #ac-1.5, #ac-1.6, #ac-1.8,
// #ac-1.9). These tests pin the run-reaper.mjs wiring that connects reaper.mjs's already-built
// sweepStaleClosedTopics to real per-project harness-crons configs, the real obs-outbox seams, and
// a persisted per-chatId permission-notification counter. Several assertions use REAL temp files
// under mkdtempSync so the enumeration/unlink seams are exercised end-to-end, never faked.
// -------------------------------------------------------------------------------------------

/**
 * @description Builds a {fn, calls} recorder: fn pushes every call's arguments into `calls` and
 * delegates to the given implementation (default: a resolved {ok:true}).
 */
function makeRecorder(impl = async () => ({ ok: true })) {
  const calls = [];
  const fn = (...args) => {
    calls.push(args);
    return impl(...args);
  };
  return { fn, calls };
}

/**
 * @description Writes a real <homeDir>/.claude/harness-crons/<project>.json config used by the
 * per-project shared-thread-blocklist tests, so the project counts as "readable" for the
 * retention sweep's config-readability gate (#ac-1.1).
 */
function writeHarnessCronsConfig(homeDir, project, obj = {}) {
  const cronsDir = join(homeDir, ".claude", "harness-crons");
  mkdirSync(cronsDir, { recursive: true });
  writeFileSync(join(cronsDir, `${project}.json`), JSON.stringify(obj), "utf8");
}

test("#ac-1.2 the underlying deleteForumTopic receives a config whose chatId is the RESOLVED chatId — never a value read off the candidate's meta", async () => {
  const config = { ...BASE_CONFIG, projects: [] };

  const recorder = makeRecorder(async () => ({ ok: true }));

  let capturedDeleteForumTopic;
  const fakeReaperLogic = (opts) => {
    capturedDeleteForumTopic = opts.deleteForumTopic;
    return [];
  };

  runReaper(config, {
    reaper: fakeReaperLogic,
    listWorktrees: () => [],
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    runLock: { release: () => {} },
    counter: { read: () => 0 },
    deleteForumTopic: recorder.fn,
    resolvedChatId: 9,
  });

  assert.equal(
    typeof capturedDeleteForumTopic,
    "function",
    "runReaper must wire a deleteForumTopic seam into the reaper logic's opts"
  );

  await capturedDeleteForumTopic({ threadId: 555 });

  assert.equal(recorder.calls.length, 1, "the underlying deleteForumTopic must be invoked once");
  const [input, opts] = recorder.calls[0];
  assert.equal(input.threadId, 555, "the threadId must be passed through unchanged");
  assert.notEqual(opts, undefined, "the underlying deleteForumTopic must receive an opts object");
  assert.equal(
    opts.config.chatId,
    9,
    "the config passed to the underlying deleteForumTopic must carry the RESOLVED chatId — never a value read from a candidate's meta"
  );
});

test("#ac-1.2 a run whose meta.chatId was stamped from the .dev.vars-resolved chatId (no config.notify block) is deleted — the dispatch stamp and the reaper resolution agree on the same resolveNotifyConfig output", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-devvars-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-state-"));
  try {
    mkdirSync(join(homeDir, ".claude"), { recursive: true });
    writeFileSync(
      join(homeDir, ".claude", ".dev.vars"),
      "TELEGRAM_BOT_TOKEN=t\nTELEGRAM_CHAT_ID=-100777\n",
      "utf8"
    );
    writeHarnessCronsConfig(homeDir, "demo", {});

    const config = {
      ...BASE_CONFIG,
      homeDir,
      stateDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 1,
    };

    const now = () => 1_000_000;
    const closedAt = now() - 2 * 86400;

    const metaPath = join(stateDir, "obs-1.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 1,
        project: "demo",
        status: "closed",
        closedAt,
        chatId: -100777,
        threadId: 555,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir, "obs-1.events.jsonl"), "", "utf8");

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    const topicCloses = runReaper(config, {
      // deps.reaper is deliberately NOT injected — the real reaper.mjs resolves resolvedChatId
      // internally so the dispatch stamp and the reaper resolution must agree.
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      deleteForumTopic: deleteForumTopicRecorder.fn,
      updateMetaIfUnchanged: (metaPath2, expected, partial) => {
        const current = JSON.parse(readFileSync(metaPath2, "utf8"));
        for (const key of Object.keys(expected)) {
          if (current[key] !== expected[key]) return false;
        }
        writeFileSync(metaPath2, JSON.stringify({ ...current, ...partial }), "utf8");
        return true;
      },
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: (p, { what }) => {
        try {
          rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
          return true;
        } catch {
          return false;
        }
      },
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    assert.equal(
      deleteForumTopicRecorder.calls.length >= 1,
      true,
      ".dev.vars-only chatId resolution must agree between the dispatch stamp and the reaper — the candidate must be deleted"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.1 shared threadIds (numeric + hand-edited string) from two per-project harness-crons configs plus the fleet build a normalized blocklist that blocks a numeric-threadId candidate", () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-blocklist-"));
  try {
    writeHarnessCronsConfig(homeDir, "demo", { sharedThreadId: 613 });
    writeHarnessCronsConfig(homeDir, "other", { sharedThreadId: "777" });

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [
        { project: "demo", projectRoot: "/srv/demo", stateDir: "/srv/demo/state" },
        { project: "other", projectRoot: "/srv/other", stateDir: "/srv/other/state" },
      ],
      sharedThreadId: 42,
    };

    let capturedOpts;
    const fakeReaperLogic = (opts) => {
      capturedOpts = opts;
      return { retentionDeletes: [], retentionTally: {} };
    };

    runReaper(config, {
      reaper: fakeReaperLogic,
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
    });

    assert.ok(Array.isArray(capturedOpts.sharedThreadIds), "runReaper must wire a sharedThreadIds array");
    const normalized = capturedOpts.sharedThreadIds.map(String);
    assert.ok(normalized.includes("613"), "the numeric per-project sharedThreadId must be normalized into the blocklist");
    assert.ok(normalized.includes("777"), "the hand-edited string per-project sharedThreadId must be normalized into the blocklist");
    assert.ok(normalized.includes("42"), "the fleet sharedThreadId must be in the blocklist");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("#ac-1.1 a real numeric-threadId candidate (613, matching the '613' normalized blocklist member contributed by a per-project harness-crons config) is DRIVEN THROUGH THE SWEEP and NEVER deleted, while a second otherwise-identical non-blocklisted candidate (threadId 500) IS deleted exactly once — proving the blocklist actually blocks, not merely that its array shape is correct", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-blocklist-real-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-blocklist-real-state-"));
  try {
    writeHarnessCronsConfig(homeDir, "demo", { sharedThreadId: 613 });

    const now = () => 1_000_000;
    const closedAt = now() - 10 * 86400;

    const metaPathBlocked = join(stateDir, "obs-61.json");
    writeFileSync(
      metaPathBlocked,
      JSON.stringify({
        issueNumber: 61,
        project: "demo",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 613,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir, "obs-61.events.jsonl"), "", "utf8");

    const metaPathAllowed = join(stateDir, "obs-62.json");
    writeFileSync(
      metaPathAllowed,
      JSON.stringify({
        issueNumber: 62,
        project: "demo",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 500,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir, "obs-62.events.jsonl"), "", "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 1,
    };

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    const topicCloses = runReaper(config, {
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicRecorder.fn,
      updateMetaIfUnchanged: (p, expected, partial) => {
        const current = JSON.parse(readFileSync(p, "utf8"));
        for (const key of Object.keys(expected)) {
          if (current[key] !== expected[key]) return false;
        }
        writeFileSync(p, JSON.stringify({ ...current, ...partial }), "utf8");
        return true;
      },
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: (p, { what }) => {
        try {
          rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
          return true;
        } catch {
          return false;
        }
      },
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    assert.equal(
      deleteForumTopicRecorder.calls.length,
      1,
      "exactly one candidate must be deleted — the blocklisted threadId 613 candidate must never be deleted, and the sweep must not have done nothing"
    );
    assert.equal(
      deleteForumTopicRecorder.calls[0][0].threadId,
      500,
      "the single delete call must be for the non-blocklisted threadId 500 candidate"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.1 an unreadable first project's harness-crons config contributes no blocklist entry, and the sweep is NOT aborted — the second (readable-config) project's eligible candidate is still evaluated", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-unreadable-"));
  const stateDir1 = mkdtempSync(join(tmpdir(), "run-crons-state1-"));
  const stateDir2 = mkdtempSync(join(tmpdir(), "run-crons-state2-"));
  try {
    // "first"'s harness-crons config is deliberately NEVER written -> unreadable/absent.
    writeHarnessCronsConfig(homeDir, "second", {});

    const now = () => 1_000_000;
    const closedAt = now() - 10 * 86400;

    const metaPath2 = join(stateDir2, "obs-2.json");
    writeFileSync(
      metaPath2,
      JSON.stringify({
        issueNumber: 2,
        project: "second",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 999,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir2, "obs-2.events.jsonl"), "", "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [
        { project: "first", projectRoot: "/srv/first", stateDir: stateDir1 },
        { project: "second", projectRoot: "/srv/second", stateDir: stateDir2 },
      ],
      topicRetentionDays: 1,
    };

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    const topicCloses = runReaper(config, {
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicRecorder.fn,
      updateMetaIfUnchanged: (p, expected, partial) => {
        const current = JSON.parse(readFileSync(p, "utf8"));
        for (const key of Object.keys(expected)) {
          if (current[key] !== expected[key]) return false;
        }
        writeFileSync(p, JSON.stringify({ ...current, ...partial }), "utf8");
        return true;
      },
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: (p, { what }) => {
        try {
          rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
          return true;
        } catch {
          return false;
        }
      },
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    assert.equal(
      deleteForumTopicRecorder.calls.length,
      1,
      "the second (readable-config) project's eligible candidate must still be evaluated — the sweep is not aborted by the first project's unreadable config"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir1, { recursive: true, force: true });
    rmSync(stateDir2, { recursive: true, force: true });
  }
});

test("#ac-1.1 the unreadable-config project's OWN otherwise-eligible candidate is DROPPED — deleteForumTopic is never called for it (fail-closed skips its own candidates, not merely its blocklist contribution)", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-ownskip-"));
  const stateDir1 = mkdtempSync(join(tmpdir(), "run-crons-ownstate1-"));
  try {
    mkdirSync(join(homeDir, ".claude", "harness-crons"), { recursive: true });
    // "first"'s harness-crons config is deliberately NEVER written -> unreadable.

    const now = () => 1_000_000;
    const closedAt = now() - 10 * 86400;

    const metaPath1 = join(stateDir1, "obs-1.json");
    writeFileSync(
      metaPath1,
      JSON.stringify({
        issueNumber: 1,
        project: "first",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 111,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir1, "obs-1.events.jsonl"), "", "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "first", projectRoot: "/srv/first", stateDir: stateDir1 }],
      topicRetentionDays: 1,
    };

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    const topicCloses = runReaper(config, {
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicRecorder.fn,
      updateMetaIfUnchanged: (p, expected, partial) => {
        const current = JSON.parse(readFileSync(p, "utf8"));
        for (const key of Object.keys(expected)) {
          if (current[key] !== expected[key]) return false;
        }
        writeFileSync(p, JSON.stringify({ ...current, ...partial }), "utf8");
        return true;
      },
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: (p, { what }) => {
        try {
          rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
          return true;
        } catch {
          return false;
        }
      },
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    assert.equal(
      deleteForumTopicRecorder.calls.length,
      0,
      "a project whose OWN harness-crons config is unreadable must have its own candidates dropped, never deleted"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir1, { recursive: true, force: true });
  }
});

test("#ac-1.4 END-TO-END real enumeration: a candidate with an unacked critical event is NEVER deleted, and its real meta + events files remain on disk — production defaultListObsRuns->readEvents is the code under test, deps.listObsRuns is NEVER injected", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-e2e-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-e2e-state-"));
  try {
    writeHarnessCronsConfig(homeDir, "demo", {});

    const now = () => 1_000_000;
    const closedAt = now() - 10 * 86400;

    const metaPath = join(stateDir, "obs-5.json");
    const eventsPath = join(stateDir, "obs-5.events.jsonl");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 5,
        project: "demo",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 555,
        cursor: 1,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(eventsPath, `${JSON.stringify({ type: "blocked" })}\n`, "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 1,
    };

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    const topicCloses = runReaper(config, {
      // deps.listObsRuns is deliberately NOT injected — the production defaultListObsRuns->readEvents
      // enumeration is exercised end-to-end.
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicRecorder.fn,
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    assert.equal(
      deleteForumTopicRecorder.calls.length,
      0,
      "a candidate with an unacked critical event must never be deleted"
    );
    assert.equal(existsSync(eventsPath), true, "the real .events.jsonl file must still exist");
    assert.equal(existsSync(metaPath), true, "the real .json meta file must still exist");
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.4 positive control: the SAME real fixture with the critical ACKED (criticalSent:[0]) IS deleted — proving the production events read actually feeds the critical guard", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-e2e-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-e2e-state-"));
  try {
    writeHarnessCronsConfig(homeDir, "demo", {});

    const now = () => 1_000_000;
    const closedAt = now() - 10 * 86400;

    const metaPath = join(stateDir, "obs-5.json");
    const eventsPath = join(stateDir, "obs-5.events.jsonl");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 5,
        project: "demo",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 555,
        cursor: 1,
        criticalSent: [0],
      }),
      "utf8"
    );
    writeFileSync(eventsPath, `${JSON.stringify({ type: "blocked" })}\n`, "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 1,
    };

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    const topicCloses = runReaper(config, {
      // deps.listObsRuns is deliberately NOT injected — the production defaultListObsRuns->readEvents
      // enumeration is exercised end-to-end.
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicRecorder.fn,
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    assert.equal(
      deleteForumTopicRecorder.calls.length,
      1,
      "the SAME fixture with the critical acked (criticalSent:[0]) must be deleted — proving the production events read actually feeds the critical guard"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.4 defaultListObsRuns called DIRECTLY returns candidates carrying events read from the real events.jsonl", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-listobsruns-"));
  try {
    const metaPath = join(stateDir, "obs-7.json");
    const eventsPath = join(stateDir, "obs-7.events.jsonl");
    writeFileSync(
      metaPath,
      JSON.stringify({ issueNumber: 7, project: "demo", status: "closed", cursor: 0 }),
      "utf8"
    );
    writeFileSync(eventsPath, `${JSON.stringify({ type: "blocked" })}\n`, "utf8");

    const readMetaFn = (p) => {
      try {
        return JSON.parse(readFileSync(p, "utf8"));
      } catch {
        return null;
      }
    };

    const runs = defaultListObsRuns([{ project: "demo", projectRoot: "/srv/demo", stateDir }], readMetaFn);

    const run = runs.find((r) => r.metaPath === metaPath);
    assert.notEqual(run, undefined, "defaultListObsRuns must return a candidate for the real obs-7.json");
    assert.ok(Array.isArray(run.events), "the candidate must carry an events array");
    assert.ok(run.events.length > 0, "the candidate's events must be non-empty (read from the real .events.jsonl)");
    assert.ok(
      run.events.some((e) => e.type === "blocked"),
      "the candidate's events must include the blocked event written to the real .events.jsonl"
    );
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.1 the {metaPath, meta, events} enumeration extension leaves sweepOrphanTopics unchanged — an orphan run (worktree gone, status:'active', threadId set, prOpen false) still gets its topic CLOSED exactly as before", async () => {
  const config = { ...BASE_CONFIG, projects: [] };

  const closeForumTopicRecorder = makeRecorder(async () => ({ ok: true }));
  const updateMetaCalls = [];

  const topicCloses = runReaper(config, {
    listWorktrees: () => [],
    gh: () => ({ ok: true }),
    ghExec: () => ({ ok: true }),
    runLock: { release: () => {} },
    counter: { read: () => 0 },
    closeForumTopic: closeForumTopicRecorder.fn,
    listObsRuns: () => [
      {
        metaPath: "/srv/demo/state/obs-9.json",
        meta: {
          issueNumber: 9,
          project: "demo",
          status: "active",
          threadId: 321,
          worktreePath: "/srv/worktrees/harness-demo-9",
        },
        events: [],
      },
    ],
    liveWorktreePaths: () => [], // the worktree is gone -> orphan
    updateMeta: (metaPath, partial) => {
      updateMetaCalls.push({ metaPath, partial });
    },
    prOpen: () => false,
  });

  await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

  assert.equal(closeForumTopicRecorder.calls.length, 1, "an orphan run's topic must be closed via closeForumTopic");
  assert.equal(
    closeForumTopicRecorder.calls[0][0].threadId,
    321,
    "closeForumTopic must be called with the orphan run's threadId"
  );
  const closedCall = updateMetaCalls.find((c) => c.partial && c.partial.status === "closed");
  assert.notEqual(closedCall, undefined, "updateMeta must write status:'closed' for the orphan run");
});

test("#ac-1.5 unlinkRunFiles unlinks the derived .events.jsonl for what:'events' and the metaPath itself for what:'meta', using REAL temp files; neither target is rebuilt from meta.issueNumber; an fs error returns false and never throws", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-unlink-"));
  try {
    const metaPath = join(stateDir, "obs-11.json");
    const eventsPath = join(stateDir, "obs-11.events.jsonl");
    writeFileSync(metaPath, JSON.stringify({ issueNumber: 11 }), "utf8");
    writeFileSync(eventsPath, "", "utf8");

    assert.equal(existsSync(eventsPath), true, "the events file must exist before unlinking");
    const eventsResult = unlinkRunFiles(metaPath, { what: "events" });
    assert.equal(eventsResult, true, "unlinkRunFiles must return true on a successful unlink");
    assert.equal(existsSync(eventsPath), false, "the .events.jsonl file must be gone after what:'events'");
    assert.equal(existsSync(metaPath), true, "the metaPath must remain untouched by what:'events'");

    assert.equal(existsSync(metaPath), true, "the meta file must exist before unlinking");
    const metaResult = unlinkRunFiles(metaPath, { what: "meta" });
    assert.equal(metaResult, true, "unlinkRunFiles must return true on a successful unlink");
    assert.equal(existsSync(metaPath), false, "the metaPath file must be gone after what:'meta'");

    const missingPath = join(stateDir, "does-not-exist.json");
    let threw = false;
    let result;
    try {
      result = unlinkRunFiles(missingPath, { what: "meta" });
    } catch {
      threw = true;
    }
    assert.equal(threw, false, "unlinkRunFiles must never throw on an fs error");
    assert.equal(result, false, "unlinkRunFiles must return false on an fs error (e.g. a non-existent path)");
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.6 config.topicRetentionDays = 3 makes a run closed 4 days ago eligible (deleteForumTopic IS called); a second run closed 4 days ago with topicRetentionDays absent (default 7) is NOT eligible (deleteForumTopic is NOT called for it)", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-retentiondays-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-retentiondays-state-"));
  const stateDirDefault = mkdtempSync(join(tmpdir(), "run-crons-retentiondays-default-state-"));
  try {
    writeHarnessCronsConfig(homeDir, "demo", {});

    const now = () => 1_000_000;
    const closedAt = now() - 4 * 86400;

    const metaPath = join(stateDir, "obs-13.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 13,
        project: "demo",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 777,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir, "obs-13.events.jsonl"), "", "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 3,
    };

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    const topicCloses = runReaper(config, {
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicRecorder.fn,
      updateMetaIfUnchanged: (p, expected, partial) => {
        const current = JSON.parse(readFileSync(p, "utf8"));
        for (const key of Object.keys(expected)) {
          if (current[key] !== expected[key]) return false;
        }
        writeFileSync(p, JSON.stringify({ ...current, ...partial }), "utf8");
        return true;
      },
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: (p, { what }) => {
        try {
          rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
          return true;
        } catch {
          return false;
        }
      },
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    assert.equal(
      deleteForumTopicRecorder.calls.length,
      1,
      "a run closed 4 days ago must be eligible when topicRetentionDays=3"
    );

    writeHarnessCronsConfig(homeDir, "demo-default", {});

    const metaPathDefault = join(stateDirDefault, "obs-14.json");
    writeFileSync(
      metaPathDefault,
      JSON.stringify({
        issueNumber: 14,
        project: "demo-default",
        status: "closed",
        closedAt,
        chatId: 9,
        threadId: 778,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDirDefault, "obs-14.events.jsonl"), "", "utf8");

    const configDefault = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo-default", projectRoot: "/srv/demo-default", stateDir: stateDirDefault }],
      // topicRetentionDays deliberately absent -> the default (7 days) must apply.
    };

    const deleteForumTopicRecorderDefault = makeRecorder(async () => ({ ok: true }));

    const topicClosesDefault = runReaper(configDefault, {
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicRecorderDefault.fn,
      updateMetaIfUnchanged: (p, expected, partial) => {
        const current = JSON.parse(readFileSync(p, "utf8"));
        for (const key of Object.keys(expected)) {
          if (current[key] !== expected[key]) return false;
        }
        writeFileSync(p, JSON.stringify({ ...current, ...partial }), "utf8");
        return true;
      },
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: (p, { what }) => {
        try {
          rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
          return true;
        } catch {
          return false;
        }
      },
    });

    await Promise.allSettled(Array.isArray(topicClosesDefault) ? topicClosesDefault : []);

    assert.equal(
      deleteForumTopicRecorderDefault.calls.length,
      0,
      "a run closed 4 days ago must NOT be eligible when topicRetentionDays is absent — the default is 7 days"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(stateDirDefault, { recursive: true, force: true });
  }
});

test("#ac-1.8 across THREE SEPARATE runReaper cycles against the same permission-state file, exactly ONE permission-check notification fires and only on the THIRD cycle; consecutiveNoDelete reaches 3 between cycles", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-permstate-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-permstate-state-"));
  const permissionStatePath = join(stateDir, "retention-permission-state.json");
  try {
    writeHarnessCronsConfig(homeDir, "demo", {});

    const now = () => 1_000_000;
    // A candidate that is ATTEMPTED (isDeletable true) but whose delete never resolves ok, so
    // attempted increments and deleted stays 0 across every cycle.
    const metaPath = join(stateDir, "obs-21.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 21,
        project: "demo",
        status: "closed",
        closedAt: now() - 10 * 86400,
        chatId: 9,
        threadId: 111,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir, "obs-21.events.jsonl"), "", "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 1,
    };

    const notifyCalls = [];
    const deleteForumTopicFailing = async () => ({ ok: false, reason: "transient" });

    const deps = {
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: deleteForumTopicFailing,
      updateMetaIfUnchanged: () => false,
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: () => true,
      permissionStatePath,
      notify: (payload) => {
        notifyCalls.push(payload);
      },
    };

    for (let cycle = 1; cycle <= 3; cycle++) {
      const topicCloses = runReaper(config, deps);
      await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

      if (cycle < 3) {
        const permissionNotifications = notifyCalls.filter((c) => c && c.type === "reaper-permission-check");
        assert.equal(
          permissionNotifications.length,
          0,
          `no permission-check notification must fire before the 3rd cycle (cycle ${cycle})`
        );
      }

      let persisted;
      try {
        persisted = JSON.parse(readFileSync(permissionStatePath, "utf8"));
      } catch {
        persisted = null;
      }
      assert.notEqual(persisted, null, `the permission-state file must be written after cycle ${cycle}`);
      const tally = persisted["9"];
      assert.notEqual(tally, undefined, `the chatId 9 entry must be present after cycle ${cycle}`);
      assert.equal(
        tally.consecutiveNoDelete,
        cycle,
        `consecutiveNoDelete must equal the cycle count (${cycle}) after cycle ${cycle}`
      );
    }

    const permissionNotifications = notifyCalls.filter((c) => c && c.type === "reaper-permission-check");
    assert.equal(
      permissionNotifications.length,
      1,
      "exactly one permission-check notification must be emitted across the three cycles"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.8 a persisted consecutiveNoDelete:3 for a chatId resets to 0 after a runReaper cycle records a successful delete for that chatId; no further permission notification fires", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-permreset-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-permreset-state-"));
  const permissionStatePath = join(stateDir, "retention-permission-state.json");
  try {
    writeHarnessCronsConfig(homeDir, "demo", {});
    writeFileSync(permissionStatePath, JSON.stringify({ "9": { consecutiveNoDelete: 3 } }), "utf8");

    const now = () => 1_000_000;
    const metaPath = join(stateDir, "obs-31.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 31,
        project: "demo",
        status: "closed",
        closedAt: now() - 10 * 86400,
        chatId: 9,
        threadId: 222,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir, "obs-31.events.jsonl"), "", "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 1,
    };

    const notifyCalls = [];

    const topicCloses = runReaper(config, {
      listWorktrees: () => [],
      gh: () => ({ ok: true }),
      ghExec: () => ({ ok: true }),
      runLock: { release: () => {} },
      counter: { read: () => 0 },
      now,
      resolvedChatId: 9,
      deleteForumTopic: async () => ({ ok: true }),
      updateMetaIfUnchanged: (p, expected, partial) => {
        const current = JSON.parse(readFileSync(p, "utf8"));
        for (const key of Object.keys(expected)) {
          if (current[key] !== expected[key]) return false;
        }
        writeFileSync(p, JSON.stringify({ ...current, ...partial }), "utf8");
        return true;
      },
      readMeta: (p) => {
        try {
          return JSON.parse(readFileSync(p, "utf8"));
        } catch {
          return null;
        }
      },
      unlinkRunFiles: (p, { what }) => {
        try {
          rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
          return true;
        } catch {
          return false;
        }
      },
      permissionStatePath,
      notify: (payload) => {
        notifyCalls.push(payload);
      },
    });

    await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);

    const persisted = JSON.parse(readFileSync(permissionStatePath, "utf8"));
    assert.equal(
      persisted["9"].consecutiveNoDelete,
      0,
      "consecutiveNoDelete must reset to 0 after a successful delete for that chatId"
    );

    const permissionNotifications = notifyCalls.filter((c) => c && c.type === "reaper-permission-check");
    assert.equal(
      permissionNotifications.length,
      0,
      "no permission-check notification must fire on the cycle that records a successful delete"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("#ac-1.9 a corrupt (non-JSON) retention-permission-state.json at the injected path never throws — runReaper treats the counter as 0, actually completes the sweep (an otherwise-eligible candidate IS deleted), and rewrites the permission-state file with valid JSON", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "run-crons-corruptstate-home-"));
  const stateDir = mkdtempSync(join(tmpdir(), "run-crons-corruptstate-state-"));
  const permissionStatePath = join(stateDir, "retention-permission-state.json");
  try {
    writeHarnessCronsConfig(homeDir, "demo", {});
    writeFileSync(permissionStatePath, "{ this is not valid json ]]", "utf8");

    const now = () => 1_000_000;
    const metaPath = join(stateDir, "obs-41.json");
    writeFileSync(
      metaPath,
      JSON.stringify({
        issueNumber: 41,
        project: "demo",
        status: "closed",
        closedAt: now() - 10 * 86400,
        chatId: 9,
        threadId: 333,
        cursor: 0,
        criticalSent: [],
      }),
      "utf8"
    );
    writeFileSync(join(stateDir, "obs-41.events.jsonl"), "", "utf8");

    const config = {
      ...BASE_CONFIG,
      homeDir,
      projects: [{ project: "demo", projectRoot: "/srv/demo", stateDir }],
      topicRetentionDays: 1,
    };

    const deleteForumTopicRecorder = makeRecorder(async () => ({ ok: true }));

    let threw = false;
    try {
      const topicCloses = runReaper(config, {
        listWorktrees: () => [],
        gh: () => ({ ok: true }),
        ghExec: () => ({ ok: true }),
        runLock: { release: () => {} },
        counter: { read: () => 0 },
        now,
        resolvedChatId: 9,
        deleteForumTopic: deleteForumTopicRecorder.fn,
        updateMetaIfUnchanged: (p, expected, partial) => {
          const current = JSON.parse(readFileSync(p, "utf8"));
          for (const key of Object.keys(expected)) {
            if (current[key] !== expected[key]) return false;
          }
          writeFileSync(p, JSON.stringify({ ...current, ...partial }), "utf8");
          return true;
        },
        readMeta: (p) => {
          try {
            return JSON.parse(readFileSync(p, "utf8"));
          } catch {
            return null;
          }
        },
        unlinkRunFiles: (p, { what }) => {
          try {
            rmSync(what === "events" ? p.replace(/\.json$/, ".events.jsonl") : p, { force: true });
            return true;
          } catch {
            return false;
          }
        },
        permissionStatePath,
      });
      await Promise.allSettled(Array.isArray(topicCloses) ? topicCloses : []);
    } catch {
      threw = true;
    }

    assert.equal(threw, false, "runReaper must never throw on a corrupt permission-state file");

    assert.equal(
      deleteForumTopicRecorder.calls.length,
      1,
      "the otherwise-eligible candidate must be deleted — the sweep must run to completion past the corrupt permission-state read, not silently return early"
    );

    let persisted;
    let parseThrew = false;
    try {
      persisted = JSON.parse(readFileSync(permissionStatePath, "utf8"));
    } catch {
      parseThrew = true;
    }
    assert.equal(
      parseThrew,
      false,
      "the permission-state file must be rewritten with valid JSON, replacing the corrupt content"
    );
    assert.equal(typeof persisted, "object", "the rewritten permission-state file must parse to a JSON object");
    assert.notEqual(persisted, null, "the rewritten permission-state file must parse to a non-null JSON object");
    assert.equal(
      persisted["9"].consecutiveNoDelete,
      0,
      "the corrupt counter must be treated as 0, and a successful delete keeps/resets it at 0"
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(stateDir, { recursive: true, force: true });
  }
});

test("run-cron-review.mjs source does not read config.runtime for session spawn (review remains Claude path)", () => {
  const src = readFileSync(new URL("./run-cron-review.mjs", import.meta.url), "utf8");
  const readsRuntime = /config\.runtime|resolveRuntime|runtime\s*[:=]/.test(src);
  assert.equal(readsRuntime, false, "run-cron-review.mjs source does not read config.runtime for session spawn (review remains Claude path)");
});
