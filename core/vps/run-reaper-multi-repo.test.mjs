/**
 * @description Pinned assertions for the MULTI-REPO fleet scoping of run-reaper.mjs's composition
 * root (task-9 glue-3 follow-up). Every worktree/orphan-run the shared reaper touches must be
 * scoped to ITS OWN project's owner/repo — never a single fleet-wide default — across BOTH gh
 * mechanisms: the NORMALIZED ghExec seam (scopedGh appends `--repo` at the end of the args array;
 * used by prExists and the crash-recovery relabel) and the RAW spawn seam (`--repo` is inline in
 * the argv; used by issueClosed/prMerged/prOpen). Every assertion here observes the WIRING through
 * injected recording fakes — never a real git/gh/tmux/fs call. All nine are expected to fail against
 * today's run-reaper.mjs, which builds ONE global `scopedGh`/`prOpen`/etc. bound to a single
 * `config.owner`/`config.repo`, ignoring per-project scoping entirely.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { runReaper } from "./run-reaper.mjs";

/** @description Two-project fleet config: proj-a on owner-a/repo-a, proj-b on owner-b/repo-b. No top-level owner/repo (the multi-repo case). */
function makeFleetConfig(overrides = {}) {
  return {
    project: "fleet",
    projectRoot: "/srv/proj-a",
    stateDir: "/srv/proj-a/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [
      { project: "proj-a", owner: "owner-a", repo: "repo-a", projectRoot: "/srv/proj-a", stateDir: "/srv/proj-a/.claude/state" },
      { project: "proj-b", owner: "owner-b", repo: "repo-b", projectRoot: "/srv/proj-b", stateDir: "/srv/proj-b/.claude/state" },
    ],
    ...overrides,
  };
}

/** @description A crash-recovery worktree fixture: registered holder whose tmux session is dead. */
function makeCrashWorktree(overrides = {}) {
  return {
    project: "proj-b",
    projectRoot: "/srv/proj-b",
    worktreePath: "/srv/worktrees/harness-proj-b-99",
    branch: "harness/99",
    issueNumber: 99,
    stateDir: "/srv/proj-b/.claude/state",
    holder: { pid: 4242, acquire_ts: 50_000, tmux_session_id: "sess-b-99" },
    sessionStartedAt: 50_000,
    ...overrides,
  };
}

/** @description A completed-sweep worktree fixture: run-lock released normally (holder null, no lock age). */
function makeCompletedWorktree(overrides = {}) {
  return {
    project: "proj-b",
    projectRoot: "/srv/proj-b",
    worktreePath: "/srv/worktrees/harness-proj-b-55",
    branch: "harness/55",
    issueNumber: 55,
    stateDir: "/srv/proj-b/.claude/state",
    holder: null,
    sessionStartedAt: 0,
    ...overrides,
  };
}

/**
 * @description Records every ghExec(args) call; `responder(args)` decides the normalized return
 * value (mirrors normalizeGhResult's shapes: `[]`/array for --json list calls, `{ok}` otherwise).
 */
function makeRecordingGhExec(responder) {
  const calls = [];
  const ghExec = (args) => {
    calls.push(args);
    return responder(args);
  };
  return { ghExec, calls };
}

/** @description Records every raw spawn(cmd, args, opts) call; `handler` decides the spawnSync-shaped return. */
function makeRecordingSpawn(handler) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return handler(cmd, args, opts);
  };
  return { spawn, calls };
}

/**
 * @description Shared raw-spawn handler for the completed-sweep tri-state probes: every probe
 * succeeds with an empty/OPEN/non-ancestor result so reapCompletedWorktree's four probes are all
 * non-null (never short-circuits before prOpen is queried), and git worktree remove/branch delete
 * are swallowed benignly by the default catch-all branch.
 */
function completedSweepSpawnHandler(cmd, args) {
  if (cmd === "git" && args.includes("log")) return { status: 0, stdout: "" };
  if (cmd === "git" && args.includes("status")) return { status: 0, stdout: "" };
  if (cmd === "git" && args.includes("merge-base")) return { status: 1, stdout: "" };
  if (cmd === "gh" && args.includes("issue") && args.includes("view")) {
    return { status: 0, stdout: JSON.stringify({ state: "OPEN" }) };
  }
  if (cmd === "gh" && args.includes("pr") && args.includes("list") && args.includes("merged")) {
    return { status: 0, stdout: "[]" };
  }
  if (cmd === "gh" && args.includes("pr") && args.includes("list") && args.includes("open")) {
    return { status: 0, stdout: "[]" };
  }
  return { status: 0, stdout: "" };
}

/** @description Asserts `args` carries the adjacent pair `"--repo", repoSlug`. */
function assertRepoScoped(args, repoSlug, message) {
  const idx = args.indexOf("--repo");
  assert.notEqual(idx, -1, `${message} — missing --repo flag entirely`);
  assert.equal(args[idx + 1], repoSlug, message);
}

test("#ac-1.2 (C4) run-reaper scopes crash-recovery ghExec calls (prExists pr-list + relabel issue-edit) to the worktree's OWN project repo, never a fleet-wide default", () => {
  const config = makeFleetConfig();
  const worktreeB = makeCrashWorktree();

  const { ghExec, calls: ghExecCalls } = makeRecordingGhExec((args) => {
    if (args.includes("issue") && args.includes("edit")) return { ok: true };
    if (args.includes("pr") && args.includes("list")) return [];
    return { ok: true };
  });

  runReaper(config, {
    listWorktrees: () => [worktreeB],
    ghExec,
    spawn: () => ({ status: 0, stdout: "" }),
    tmuxHasSession: () => false,
    kill: () => {},
    now: () => 100_000,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  const prExistsCall = ghExecCalls.find((args) => args.includes("pr") && args.includes("list"));
  const relabelCall = ghExecCalls.find((args) => args.includes("issue") && args.includes("edit"));

  assert.notEqual(prExistsCall, undefined, "prExists must issue a gh pr list call for the crash-recovery worktree");
  assert.notEqual(relabelCall, undefined, "crash recovery must issue a gh issue edit relabel call");

  assertRepoScoped(prExistsCall, "owner-b/repo-b", "the prExists pr-list call must be scoped to project B's own repo");
  assertRepoScoped(relabelCall, "owner-b/repo-b", "the relabel issue-edit call must be scoped to project B's own repo");
});

test("#ac-1.2 (C4) run-reaper scopes the completed-sweep raw-spawn gh calls (issue view, pr list merged, pr list open) to the worktree's OWN project repo", () => {
  const config = makeFleetConfig();
  const worktreeB = makeCompletedWorktree();

  const { spawn, calls: spawnCalls } = makeRecordingSpawn(completedSweepSpawnHandler);

  runReaper(config, {
    listWorktrees: () => [worktreeB],
    ghExec: () => ({ ok: true }),
    spawn,
    tmuxHasSession: () => false,
    kill: () => {},
    now: () => 100_000,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  const issueViewCall = spawnCalls.find((c) => c.cmd === "gh" && c.args.includes("issue") && c.args.includes("view"));
  const prMergedCall = spawnCalls.find(
    (c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("list") && c.args.includes("merged")
  );
  const prOpenCall = spawnCalls.find(
    (c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("list") && c.args.includes("open")
  );

  assert.notEqual(issueViewCall, undefined, "issueClosed must issue a gh issue view call");
  assert.notEqual(prMergedCall, undefined, "prMerged must issue a gh pr list --state merged call");
  assert.notEqual(prOpenCall, undefined, "prOpen must issue a gh pr list --state open call");

  assertRepoScoped(issueViewCall.args, "owner-b/repo-b", "issue view must be scoped to project B's own repo");
  assertRepoScoped(prMergedCall.args, "owner-b/repo-b", "pr list merged must be scoped to project B's own repo");
  assertRepoScoped(prOpenCall.args, "owner-b/repo-b", "pr list open must be scoped to project B's own repo");
});

test("#ac-1.3 run-reaper never crosses repo scoping between two projects sharing the same issue number (#5 on both owner-a/repo-a and owner-b/repo-b)", () => {
  const config = makeFleetConfig();
  const worktreeA = makeCrashWorktree({
    project: "proj-a",
    projectRoot: "/srv/proj-a",
    worktreePath: "/srv/worktrees/harness-proj-a-5",
    branch: "harness/5",
    issueNumber: 5,
    stateDir: "/srv/proj-a/.claude/state",
    holder: { pid: 1111, acquire_ts: 50_000, tmux_session_id: "sess-a-5" },
  });
  const worktreeB = makeCompletedWorktree({
    project: "proj-b",
    projectRoot: "/srv/proj-b",
    worktreePath: "/srv/worktrees/harness-proj-b-5",
    branch: "harness/5",
    issueNumber: 5,
    stateDir: "/srv/proj-b/.claude/state",
  });

  const { ghExec, calls: ghExecCalls } = makeRecordingGhExec((args) => {
    if (args.includes("issue") && args.includes("edit")) return { ok: true };
    if (args.includes("pr") && args.includes("list")) return [];
    return { ok: true };
  });
  const { spawn, calls: spawnCalls } = makeRecordingSpawn(completedSweepSpawnHandler);

  runReaper(config, {
    listWorktrees: () => [worktreeA, worktreeB],
    ghExec,
    spawn,
    tmuxHasSession: () => false,
    kill: () => {},
    now: () => 100_000,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.ok(ghExecCalls.length > 0, "project A's crash recovery (issue #5) must issue ghExec calls");
  for (const args of ghExecCalls) {
    assertRepoScoped(
      args,
      "owner-a/repo-a",
      "every ghExec call belongs to project A's crash-recovery worktree and must scope to owner-a/repo-a"
    );
    assert.ok(!args.includes("owner-b/repo-b"), "no ghExec call for A's #5 may ever carry owner-b/repo-b");
  }

  const spawnGhCalls = spawnCalls.filter((c) => c.cmd === "gh");
  assert.ok(spawnGhCalls.length > 0, "project B's completed sweep (issue #5) must issue raw-spawn gh calls");
  for (const call of spawnGhCalls) {
    assertRepoScoped(
      call.args,
      "owner-b/repo-b",
      "every raw-spawn gh call belongs to project B's completed-sweep worktree and must scope to owner-b/repo-b"
    );
    assert.ok(!call.args.includes("owner-a/repo-a"), "no raw-spawn gh call for B's #5 may ever carry owner-a/repo-a");
  }
});

test("#ac-1.2 (C2) run-reaper's captured seams fail CLOSED for a project absent from the fleet index — issueClosed/prMerged null, prExists false, gh().ok false, and NO ghExec/spawn call is ever issued", () => {
  const config = makeFleetConfig();

  let capturedReaperOpts;
  const fakeReaperLogic = (opts) => {
    capturedReaperOpts = opts;
    return [];
  };

  const { ghExec, calls: ghExecCalls } = makeRecordingGhExec(() => ({ ok: true }));
  const { spawn, calls: spawnCalls } = makeRecordingSpawn(() => ({ status: 0, stdout: "[]" }));

  runReaper(config, {
    reaper: fakeReaperLogic,
    listWorktrees: () => [],
    ghExec,
    spawn,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.equal(
    capturedReaperOpts.issueClosed(5, "ghost"),
    null,
    "issueClosed for an unknown project must be null (unknown), never a guess"
  );
  assert.equal(
    capturedReaperOpts.prMerged(5, "ghost"),
    null,
    "prMerged for an unknown project must be null (unknown), never a guess"
  );
  assert.equal(
    capturedReaperOpts.prExists(5, "ghost"),
    false,
    "prExists for an unknown project must fail closed to false"
  );
  assert.equal(
    capturedReaperOpts.gh(["issue", "view", "5"], "ghost").ok,
    false,
    "gh() for an unknown project must fail closed with ok:false"
  );

  assert.equal(ghExecCalls.length, 0, "no ghExec call may ever be issued for a project absent from the fleet index");
  assert.equal(spawnCalls.length, 0, "no raw-spawn call may ever be issued for a project absent from the fleet index");
});

test("#ac-1.2 (C2) run-reaper's captured prOpen seam fails OPEN (true) for a project absent from the fleet index — never close a topic under uncertainty", () => {
  const config = makeFleetConfig();

  let capturedReaperOpts;
  const fakeReaperLogic = (opts) => {
    capturedReaperOpts = opts;
    return [];
  };

  runReaper(config, {
    reaper: fakeReaperLogic,
    listWorktrees: () => [],
    ghExec: () => ({ ok: true }),
    spawn: () => ({ status: 0, stdout: "[]" }),
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.equal(
    capturedReaperOpts.prOpen(5, "ghost"),
    true,
    "prOpen for an unknown project must fail OPEN (true) — an unresolvable repo must never authorize a close/prune"
  );
});

test("#ac-1.2 (C3) run-reaper's captured prOpen seam memoizes the raw-spawn pr-list fetch PER distinct owner/repo slug — exactly one fetch per repo, never shared across repos, never refetched per call", () => {
  const config = makeFleetConfig();

  let capturedReaperOpts;
  const fakeReaperLogic = (opts) => {
    capturedReaperOpts = opts;
    return [];
  };

  const { spawn, calls: spawnCalls } = makeRecordingSpawn((cmd, args) => {
    if (cmd === "gh" && args.includes("pr") && args.includes("list") && args.includes("open")) {
      const idx = args.indexOf("--repo");
      const repoSlug = args[idx + 1];
      if (repoSlug === "owner-a/repo-a") {
        return {
          status: 0,
          stdout: JSON.stringify([
            { number: 9, headRefName: "harness/7", url: "https://github.com/owner-a/repo-a/pull/9", body: "" },
          ]),
        };
      }
      return { status: 0, stdout: "[]" };
    }
    return { status: 0, stdout: "[]" };
  });

  runReaper(config, {
    reaper: fakeReaperLogic,
    listWorktrees: () => [],
    ghExec: () => ({ ok: true }),
    spawn,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.equal(capturedReaperOpts.prOpen(7, "proj-a"), true, "owner-a/repo-a has an OPEN harness/7 PR");
  assert.equal(
    capturedReaperOpts.prOpen(7, "proj-a"),
    true,
    "a repeated call for the same repo must hit the memo, not refetch"
  );
  assert.equal(capturedReaperOpts.prOpen(7, "proj-b"), false, "owner-b/repo-b has no OPEN PR for #7");
  assert.equal(
    capturedReaperOpts.prOpen(7, "proj-b"),
    false,
    "a repeated call for the same repo must hit the memo, not refetch"
  );

  const openFetches = spawnCalls.filter(
    (c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("list") && c.args.includes("open")
  );
  const fetchesByRepo = new Map();
  for (const call of openFetches) {
    const idx = call.args.indexOf("--repo");
    const repoSlug = call.args[idx + 1];
    fetchesByRepo.set(repoSlug, (fetchesByRepo.get(repoSlug) ?? 0) + 1);
  }

  assert.equal(
    openFetches.length,
    2,
    "exactly 2 fetches total — one per distinct repo slug, not 1 (shared cache) and not 4 (unmemoized)"
  );
  assert.equal(fetchesByRepo.get("owner-a/repo-a"), 1, "owner-a/repo-a must be fetched exactly once despite 2 prOpen calls");
  assert.equal(fetchesByRepo.get("owner-b/repo-b"), 1, "owner-b/repo-b must be fetched exactly once despite 2 prOpen calls");
});

test("#ac-1.2 (C5) run-reaper backfills a legacy config.projects entry (no owner/repo) from the fleet-level owner/repo, never the literal undefined/undefined, and the reaper is not left inert", () => {
  const config = {
    project: "proj-a",
    owner: "owner-a",
    repo: "repo-a",
    projectRoot: "/srv/proj-a",
    stateDir: "/srv/proj-a/.claude/state",
    worktreeRoot: "/srv/worktrees",
    homeDir: "/home/harness",
    projects: [{ project: "proj-a", projectRoot: "/srv/proj-a", stateDir: "/srv/proj-a/.claude/state" }],
  };

  const worktreeA = makeCrashWorktree({
    project: "proj-a",
    projectRoot: "/srv/proj-a",
    worktreePath: "/srv/worktrees/harness-proj-a-77",
    branch: "harness/77",
    issueNumber: 77,
    stateDir: "/srv/proj-a/.claude/state",
    holder: { pid: 7777, acquire_ts: 50_000, tmux_session_id: "sess-a-77" },
  });

  const { ghExec, calls: ghExecCalls } = makeRecordingGhExec((args) => {
    if (args.includes("issue") && args.includes("edit")) return { ok: true };
    if (args.includes("pr") && args.includes("list")) return [];
    return { ok: true };
  });

  runReaper(config, {
    listWorktrees: () => [worktreeA],
    ghExec,
    spawn: () => ({ status: 0, stdout: "" }),
    tmuxHasSession: () => false,
    kill: () => {},
    now: () => 100_000,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.ok(ghExecCalls.length > 0, "the reaper must not be left inert for a legacy config.projects entry missing owner/repo");
  for (const args of ghExecCalls) {
    assertRepoScoped(
      args,
      "owner-a/repo-a",
      "a legacy project entry without owner/repo must be backfilled from the fleet-level config.owner/config.repo"
    );
    assert.ok(
      !args.includes("undefined/undefined"),
      "a legacy project entry must never resolve to the literal undefined/undefined --repo value"
    );
  }
});

test("#ac-1.2 (C6) sweepOrphanTopics resolves the prOpen repo scope from the orphan run's OWN meta.project, never a fleet default", () => {
  const config = makeFleetConfig();

  const orphanMeta = {
    issueNumber: 88,
    project: "proj-b",
    worktreePath: "/srv/worktrees/harness-proj-b-88",
    threadId: 555,
    status: "active",
  };
  const orphanRun = { metaPath: "/srv/proj-b/.claude/state/obs-88.json", meta: orphanMeta };

  const { spawn, calls: spawnCalls } = makeRecordingSpawn(() => ({ status: 0, stdout: "[]" }));

  const closeForumTopicCalls = [];
  const closeForumTopic = (input) => {
    closeForumTopicCalls.push(input);
    return Promise.resolve({ ok: true });
  };

  const updateMetaCalls = [];
  const updateMeta = (metaPath, partial) => {
    updateMetaCalls.push({ metaPath, partial });
  };

  runReaper(config, {
    listWorktrees: () => [],
    listObsRuns: () => [orphanRun],
    liveWorktreePaths: () => [],
    closeForumTopic,
    updateMeta,
    ghExec: () => ({ ok: true }),
    spawn,
    tmuxHasSession: () => false,
    kill: () => {},
    now: () => 100_000,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  const prOpenCall = spawnCalls.find(
    (c) => c.cmd === "gh" && c.args.includes("pr") && c.args.includes("list") && c.args.includes("open")
  );
  assert.notEqual(prOpenCall, undefined, "the orphan sweep must query prOpen for the orphan run's issue");
  assertRepoScoped(
    prOpenCall.args,
    "owner-b/repo-b",
    "the orphan sweep's prOpen query must be scoped to project B's own repo, resolved from meta.project — never a fleet default"
  );
});

test("#ac-1.2 (C2, C6) sweepOrphanTopics fails OPEN for a run whose meta.project is absent from the fleet index — its topic is never closed and its meta is never marked closed", () => {
  const config = makeFleetConfig();

  const orphanMeta = {
    issueNumber: 99,
    project: "ghost-project",
    worktreePath: "/srv/worktrees/harness-ghost-99",
    threadId: 777,
    status: "active",
  };
  const orphanRun = { metaPath: "/srv/ghost/.claude/state/obs-99.json", meta: orphanMeta };

  const { spawn } = makeRecordingSpawn(() => ({ status: 0, stdout: "[]" }));

  const closeForumTopicCalls = [];
  const closeForumTopic = (input) => {
    closeForumTopicCalls.push(input);
    return Promise.resolve({ ok: true });
  };

  const updateMetaCalls = [];
  const updateMeta = (metaPath, partial) => {
    updateMetaCalls.push({ metaPath, partial });
  };

  runReaper(config, {
    listWorktrees: () => [],
    listObsRuns: () => [orphanRun],
    liveWorktreePaths: () => [],
    closeForumTopic,
    updateMeta,
    ghExec: () => ({ ok: true }),
    spawn,
    tmuxHasSession: () => false,
    kill: () => {},
    now: () => 100_000,
    runLock: { release: () => {} },
    counter: { read: () => 0 },
  });

  assert.equal(
    closeForumTopicCalls.some((c) => c.threadId === orphanMeta.threadId),
    false,
    "closeForumTopic must NEVER be called for a run whose project cannot be resolved to a repo"
  );
  assert.equal(
    updateMetaCalls.some((c) => c.metaPath === orphanRun.metaPath && c.partial && c.partial.status === "closed"),
    false,
    "updateMeta must NEVER write status:'closed' for a run whose project cannot be resolved to a repo"
  );
});
