/**
 * @description Contract tests for reaper.mjs — the ONE shared VPS cron that enumerates every
 * Cron-A worktree across EVERY project (not scoped to one) and, per worktree, decides liveness
 * with the SAME two-branch rule as run-lock.mjs's acquire(): a REGISTERED holder
 * (tmux_session_id present) is alive iff tmuxHasSession() alone (the launcher pid is never
 * consulted once registered — a live tmux session with a dead launcher pid is the expected
 * steady state and is ALIVE); a NOT-YET-REGISTERED holder is alive iff kill(pid) does not throw
 * AND it is still within the registration grace window.
 *
 * Every seam (listWorktrees, tmuxHasSession, kill, now, prExists, issueLabels, gh, runLock.release,
 * counter.read, gitWorktreeRemove, tmuxKillSession) is an in-memory fake recording every call it
 * receives — no real git/tmux/gh/process is ever touched. Assertions are made exclusively on
 * those recorded-call arrays (the observables), never on a return value from reaper().
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reaper } from "./reaper.mjs";

const LIVENESS_CEILING_HOURS = 2;
const REGISTRATION_GRACE_SECONDS = 120;
const RETRY_CEILING_K = 2;

/** @description Fake pid-liveness probe that always reports "alive" (never throws). */
function aliveKill() {}

/** @description Fake pid-liveness probe that always reports "dead" (throws ESRCH). */
function deadKill() {
  const err = new Error("kill ESRCH");
  err.code = "ESRCH";
  throw err;
}

/** @description Fake tmux-session probe backed by a fixed set of session ids reported alive. */
function makeTmuxHasSession(aliveSessionIds) {
  return (sessionId) => aliveSessionIds.has(sessionId);
}

/** @description Fake gh seam. Records each argv array (e.g. `["issue","edit",...]`). */
function makeFakeGh() {
  const calls = [];
  function gh(args) {
    calls.push(args);
    return { ok: true };
  }
  return { gh, calls };
}

/** @description Fake run-lock seam exposing only `release` — the reaper never acquires/registers. */
function makeFakeRunLock() {
  const releaseCalls = [];
  return {
    runLock: {
      release(args) {
        releaseCalls.push(args);
      },
    },
    releaseCalls,
  };
}

/** @description Fake READ-ONLY per-issue attempt counter seam; `counts` maps issueNumber -> value. */
function makeFakeCounter(counts) {
  return {
    read(issueNumber) {
      return counts[issueNumber] ?? 0;
    },
  };
}

/** @description Fake PR-existence seam; `issueNumbers` is the set of issues with an open/merged harness PR. */
function makePrExists(issueNumbersWithPr = new Set()) {
  return (issueNumber, _project) => issueNumbersWithPr.has(issueNumber);
}

/** @description Fake issue-labels seam; `labelsByIssue` maps issueNumber -> array of label strings. */
function makeIssueLabels(labelsByIssue = {}) {
  return (issueNumber) => labelsByIssue[issueNumber] ?? [];
}

/** @description Records every `gitWorktreeRemove(path)` call into an array. */
function makeGitWorktreeRemove() {
  const calls = [];
  return { gitWorktreeRemove: (path) => calls.push(path), calls };
}

/** @description Records every `tmuxKillSession(sessionId)` call into an array. */
function makeTmuxKillSession() {
  const calls = [];
  return { tmuxKillSession: (sessionId) => calls.push(sessionId), calls };
}

/** @description Records every `rmOutputLog(stateDir, issueNumber)` call into an array. */
function makeRmOutputLog() {
  const calls = [];
  return { rmOutputLog: (stateDir, issueNumber) => calls.push({ stateDir, issueNumber }), calls };
}

/** @description Fake token-bound closeForumTopic seam; records every `{threadId}` call and resolves with `ack`. */
function makeCloseForumTopic(ack = { ok: true }) {
  const calls = [];
  return {
    closeForumTopic: (input) => {
      calls.push(input);
      return Promise.resolve(ack);
    },
    calls,
  };
}

/** @description Fake obs-outbox updateMeta seam; records every `{metaPath, partial}` call. */
function makeUpdateMeta() {
  const calls = [];
  return {
    updateMeta: (metaPath, partial) => calls.push({ metaPath, partial }),
    calls,
  };
}

/**
 * @description Records every `gitWorktreeRemove(path, projectRoot, opts)` call including the
 * optional third argument, so a test can assert whether `{ force: true }` was passed on the safe
 * prune path vs. omitted/false on the keep-branch path. Kept SEPARATE from `makeGitWorktreeRemove`
 * above — the existing frozen tests keep using that path-only fake and their existing assertions
 * untouched.
 */
function makeGitWorktreeRemoveDetailed() {
  const calls = [];
  return {
    gitWorktreeRemove: (path, projectRoot, opts) => calls.push({ path, projectRoot, opts }),
    calls,
  };
}

/** @description Records every `gitBranchDelete(branch, projectRoot)` call into an array. */
function makeGitBranchDelete() {
  const calls = [];
  return {
    gitBranchDelete: (branch, projectRoot) => calls.push({ branch, projectRoot }),
    calls,
  };
}

/** @description Fake tri-state issueClosed probe; records each issueNumber it is asked about. */
function makeIssueClosed(result) {
  const calls = [];
  return {
    issueClosed: (issueNumber, _project) => {
      calls.push(issueNumber);
      return result;
    },
    calls,
  };
}

/** @description Fake tri-state prMerged probe; records each issueNumber it is asked about. */
function makePrMerged(result) {
  const calls = [];
  return {
    prMerged: (issueNumber, _project) => {
      calls.push(issueNumber);
      return result;
    },
    calls,
  };
}

/** @description Fake tri-state branchMerged probe; records each `{branch, projectRoot}` it is asked about. */
function makeBranchMerged(result) {
  const calls = [];
  return {
    branchMerged: (branch, projectRoot) => {
      calls.push({ branch, projectRoot });
      return result;
    },
    calls,
  };
}

/** @description Fake inspectWorktree probe; records each worktree path it is asked about and returns the fixed result (or null for "unknown"). */
function makeInspectWorktree(result) {
  const calls = [];
  return {
    inspectWorktree: (worktree) => {
      calls.push(worktree);
      return result;
    },
    calls,
  };
}

/** @description Builds one listWorktrees() entry with sensible defaults, overridable per test. */
function makeEntry(overrides = {}) {
  return {
    project: "demo-project",
    projectRoot: "/root/dev/demo-project",
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-1",
    branch: "harness/1",
    issueNumber: 1,
    stateDir: "/root/dev/demo-project/.claude/state",
    holder: { pid: 111, acquire_ts: 0 },
    sessionStartedAt: 0,
    ...overrides,
  };
}

/** @description Assembles a full reaper() opts object from defaults + per-test overrides. */
function baseOpts(overrides = {}) {
  return {
    listWorktrees: () => [],
    tmuxHasSession: () => false,
    kill: aliveKill,
    now: () => 100_000,
    livenessCeilingHours: LIVENESS_CEILING_HOURS,
    registrationGraceSeconds: REGISTRATION_GRACE_SECONDS,
    retryCeilingK: RETRY_CEILING_K,
    prExists: makePrExists(),
    issueLabels: makeIssueLabels(),
    gh: makeFakeGh().gh,
    runLock: makeFakeRunLock().runLock,
    counter: makeFakeCounter({}),
    gitWorktreeRemove: makeGitWorktreeRemove().gitWorktreeRemove,
    tmuxKillSession: makeTmuxKillSession().tmuxKillSession,
    ...overrides,
  };
}

test("reaper: removes the worktree of an exited session, and NEVER the worktree of a live within-ceiling session", () => {
  const now = () => 100_000;
  const w1 = makeEntry({
    project: "project-x",
    worktreePath: "/root/dev/project-x/.worktrees/harness-project-x-1",
    issueNumber: 1,
    holder: { pid: 111, acquire_ts: 90_000, tmux_session_id: "sess-1" }, // registered, session exited
    sessionStartedAt: 90_000,
  });
  const w2 = makeEntry({
    project: "project-x",
    worktreePath: "/root/dev/project-x/.worktrees/harness-project-x-2",
    issueNumber: 2,
    holder: { pid: 222, acquire_ts: 96_400, tmux_session_id: "sess-2" }, // registered, alive, 1h old
    sessionStartedAt: 96_400,
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemove();
  const { tmuxKillSession, calls: killCalls } = makeTmuxKillSession();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [w1, w2],
      tmuxHasSession: makeTmuxHasSession(new Set(["sess-2"])), // sess-1 is gone (exited)
      prExists: makePrExists(),
      counter: makeFakeCounter({ 1: 0 }),
      gitWorktreeRemove,
      tmuxKillSession,
    })
  );

  assert.ok(removeCalls.includes(w1.worktreePath), "the exited session's worktree must be removed");
  assert.ok(!removeCalls.includes(w2.worktreePath), "a live within-ceiling worktree must NEVER be removed");
  assert.ok(!killCalls.includes("sess-2"), "a live within-ceiling session must never be killed either");
});

test("reaper: kills a still-alive tmux session once it is past the wall-clock liveness ceiling (hung-run watchdog)", () => {
  const now = () => 100_000;
  const overAge = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-9",
    issueNumber: 9,
    holder: { pid: 999, acquire_ts: 100_000 - 3 * 3600, tmux_session_id: "sess-hung" },
    sessionStartedAt: 100_000 - 3 * 3600, // 3h old, past the 2h default ceiling
  });

  const { tmuxKillSession, calls: killCalls } = makeTmuxKillSession();
  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemove();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [overAge],
      tmuxHasSession: makeTmuxHasSession(new Set(["sess-hung"])), // still alive
      gitWorktreeRemove,
      tmuxKillSession,
    })
  );

  assert.ok(killCalls.includes("sess-hung"), "an over-ceiling still-alive session must be killed by the watchdog");
  assert.equal(removeCalls.length, 0, "the watchdog kill alone must not also remove the worktree this cycle");
});

test("reaper: crash-recovers a dead-session issue — relabels ready under the retry ceiling, blocked at/over it, and always releases the stale lock", () => {
  const now = () => 100_000;

  // Sub-case A: attempt counter (1) < retryCeilingK (2) -> harness:ready.
  const underCeiling = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-42",
    issueNumber: 42,
    stateDir: "/root/dev/demo-project/.claude/state",
    holder: { pid: 4242, acquire_ts: 50_000, tmux_session_id: "sess-42-a" }, // dead session
  });
  const { gh: ghA, calls: ghCallsA } = makeFakeGh();
  const { runLock: runLockA, releaseCalls: releaseCallsA } = makeFakeRunLock();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [underCeiling],
      tmuxHasSession: () => false, // session exited
      prExists: makePrExists(), // no PR
      counter: makeFakeCounter({ 42: 1 }),
      gh: ghA,
      runLock: runLockA,
    })
  );

  assert.ok(
    ghCallsA.some(
      (args) =>
        args.includes(String(42)) && args.includes("--add-label") && args.includes("harness:ready")
    ),
    "under the retry ceiling, the issue must be relabeled to harness:ready"
  );
  assert.ok(
    releaseCallsA.some((args) => args.acquireTs === 50_000),
    "the stale run-lock holder must be released"
  );

  // Sub-case B: attempt counter (2) >= retryCeilingK (2) -> harness:blocked.
  const atCeiling = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-42",
    issueNumber: 42,
    stateDir: "/root/dev/demo-project/.claude/state",
    holder: { pid: 4343, acquire_ts: 60_000, tmux_session_id: "sess-42-b" }, // dead session
  });
  const { gh: ghB, calls: ghCallsB } = makeFakeGh();
  const { runLock: runLockB, releaseCalls: releaseCallsB } = makeFakeRunLock();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [atCeiling],
      tmuxHasSession: () => false, // session exited
      prExists: makePrExists(), // no PR
      counter: makeFakeCounter({ 42: 2 }),
      gh: ghB,
      runLock: runLockB,
    })
  );

  assert.ok(
    ghCallsB.some(
      (args) =>
        args.includes(String(42)) && args.includes("--add-label") && args.includes("harness:blocked")
    ),
    "at/over the retry ceiling, the issue must be relabeled to harness:blocked instead"
  );
  assert.ok(
    releaseCallsB.some((args) => args.acquireTs === 60_000),
    "the stale run-lock holder must be released in the blocked sub-case too"
  );
});

test("reaper: crash-recovering a dead-session issue WITHOUT a PR best-effort removes its orphaned raw output log", () => {
  const now = () => 100_000;
  const entry = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-77",
    issueNumber: 77,
    stateDir: "/root/dev/demo-project/.claude/state",
    holder: { pid: 7777, acquire_ts: 50_000, tmux_session_id: "sess-77" }, // dead session
  });
  const { rmOutputLog, calls } = makeRmOutputLog();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [entry],
      tmuxHasSession: () => false, // session exited
      prExists: makePrExists(), // no PR — the crash left the session's output orphaned
      counter: makeFakeCounter({ 77: 0 }),
      rmOutputLog,
    })
  );

  assert.deepEqual(
    calls,
    [{ stateDir: "/root/dev/demo-project/.claude/state", issueNumber: 77 }],
    "crash-recovery without a PR must best-effort remove issue-77-output.log via the injected rmOutputLog seam"
  );
});

test("reaper: crash-recovering a dead-session issue that already HAS a PR does NOT touch the output log (the session reached cron-a-exit's own cleanup)", () => {
  const now = () => 100_000;
  const entry = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-88",
    issueNumber: 88,
    stateDir: "/root/dev/demo-project/.claude/state",
    holder: { pid: 8888, acquire_ts: 50_000, tmux_session_id: "sess-88" }, // dead session
  });
  const { rmOutputLog, calls } = makeRmOutputLog();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [entry],
      tmuxHasSession: () => false, // session exited
      prExists: makePrExists(new Set([88])), // PR exists
      counter: makeFakeCounter({ 88: 0 }),
      rmOutputLog,
    })
  );

  assert.deepEqual(calls, [], "crash-recovery with an existing PR must not call rmOutputLog");
});

test("reaper: processes Cron-A worktrees from MULTIPLE projects within a single invocation (one shared cron across the whole VPS)", () => {
  const now = () => 100_000;
  const entryX = makeEntry({
    project: "project-x",
    projectRoot: "/root/dev/project-x",
    worktreePath: "/root/dev/project-x/.worktrees/harness-project-x-100",
    issueNumber: 100,
    stateDir: "/root/dev/project-x/.claude/state",
    holder: { pid: 100100, acquire_ts: 50_000, tmux_session_id: "sess-x-100" }, // dead
  });
  const entryY = makeEntry({
    project: "project-y",
    projectRoot: "/root/dev/project-y",
    worktreePath: "/root/dev/project-y/.worktrees/harness-project-y-200",
    issueNumber: 200,
    stateDir: "/root/dev/project-y/.claude/state",
    holder: { pid: 200200, acquire_ts: 50_000, tmux_session_id: "sess-y-200" }, // dead
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemove();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [entryX, entryY],
      tmuxHasSession: () => false, // both sessions exited
      prExists: makePrExists(),
      counter: makeFakeCounter({ 100: 0, 200: 0 }),
      gitWorktreeRemove,
    })
  );

  assert.ok(removeCalls.includes(entryX.worktreePath), "project-x's worktree must be processed in this run");
  assert.ok(removeCalls.includes(entryY.worktreePath), "project-y's worktree must ALSO be processed in the SAME run");
});

test("reaper: an unregistered holder with a live pid inside the registration grace is treated as alive — no kill, no ready relabel, no release", () => {
  const now = () => 100_000;
  const withinGrace = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-7",
    issueNumber: 7,
    holder: { pid: 777, acquire_ts: 100_000 - 60 }, // no tmux_session_id yet, 60s old (< 120s grace)
  });

  const { gh, calls: ghCalls } = makeFakeGh();
  const { runLock, releaseCalls } = makeFakeRunLock();
  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemove();
  const { tmuxKillSession, calls: killCalls } = makeTmuxKillSession();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [withinGrace],
      kill: aliveKill, // pid is alive
      tmuxHasSession: () => false, // irrelevant: not yet registered
      gh,
      runLock,
      gitWorktreeRemove,
      tmuxKillSession,
    })
  );

  assert.equal(killCalls.length, 0, "an initializing holder within grace must never have anything killed");
  assert.ok(
    !ghCalls.some((args) => args.includes(String(7)) && args.includes("harness:ready")),
    "an initializing holder within grace must never be relabeled to harness:ready"
  );
  assert.equal(releaseCalls.length, 0, "an initializing holder within grace must never have its lock released");
  assert.equal(removeCalls.length, 0, "an initializing holder within grace must never have its worktree removed");
});

test("reaper: a registered holder with a live tmux session but a DEAD launcher pid is the healthy steady state — never reaped", () => {
  const now = () => 100_000;
  const healthySteadyState = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-42",
    issueNumber: 42,
    holder: { pid: 4242, acquire_ts: 100_000 - 3600, tmux_session_id: "sess-42" }, // registered
    sessionStartedAt: 100_000 - 3600, // 1h old, within the 2h ceiling
  });

  const { gh, calls: ghCalls } = makeFakeGh();
  const { runLock, releaseCalls } = makeFakeRunLock();
  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemove();
  const { tmuxKillSession, calls: killCalls } = makeTmuxKillSession();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [healthySteadyState],
      kill: deadKill, // the ephemeral launcher already exited by design
      tmuxHasSession: makeTmuxHasSession(new Set(["sess-42"])), // the detached session is alive
      gh,
      runLock,
      gitWorktreeRemove,
      tmuxKillSession,
    })
  );

  assert.equal(killCalls.length, 0, "a registered live tmux session must never be killed regardless of a dead launcher pid");
  assert.equal(removeCalls.length, 0, "a registered live tmux session's worktree must never be removed");
  assert.ok(
    !ghCalls.some((args) => args.includes(String(42)) && args.includes("harness:ready")),
    "a registered live tmux session must never trigger a ready relabel"
  );
  assert.equal(releaseCalls.length, 0, "a registered live tmux session's lock must never be released");
});

test("reaper: an issue labeled harness:in-review is NEVER relabeled to ready or blocked even when its PR is GONE and its holder is dead (in-review is owned by the review phase's reconciliation, not orphan crash-recovery)", () => {
  const now = () => 100_000;
  const inReviewPrGone = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-55",
    issueNumber: 55,
    stateDir: "/root/dev/demo-project/.claude/state",
    holder: { pid: 5555, acquire_ts: 50_000, tmux_session_id: "sess-55" }, // dead session -> crashRecover would fire
  });

  const { gh, calls: ghCalls } = makeFakeGh();
  const { runLock, releaseCalls } = makeFakeRunLock();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [inReviewPrGone],
      tmuxHasSession: () => false, // session exited -> holder dead
      prExists: makePrExists(), // PR is GONE — the vacuous !prExists guard alone would let crashRecover relabel
      issueLabels: makeIssueLabels({ 55: ["harness:in-review"] }),
      counter: makeFakeCounter({ 55: 0 }), // 0 < retryCeilingK (2) — would resolve to harness:ready, not blocked
      gh,
      runLock,
    })
  );

  assert.ok(
    !ghCalls.some(
      (args) =>
        args.includes(String(55)) &&
        args.includes("--add-label") &&
        (args.includes("harness:ready") || args.includes("harness:blocked"))
    ),
    "an in-review issue must never be relabeled to ready or blocked, even with its PR gone and a dead holder — it is left to the review phase's reconciliation, never mistaken for an orphan"
  );
});

test("reaper: a genuinely orphaned harness:in-progress worktree with NO PR is still relabeled ready under the retry ceiling — unchanged crash-recovery, not conflated with in-review", () => {
  const now = () => 100_000;
  const trueOrphan = makeEntry({
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-66",
    issueNumber: 66,
    stateDir: "/root/dev/demo-project/.claude/state",
    holder: { pid: 6666, acquire_ts: 50_000, tmux_session_id: "sess-66" }, // dead session
  });

  const { gh, calls: ghCalls } = makeFakeGh();
  const { runLock, releaseCalls } = makeFakeRunLock();

  reaper(
    baseOpts({
      now,
      listWorktrees: () => [trueOrphan],
      tmuxHasSession: () => false, // session exited
      prExists: makePrExists(), // no PR -> genuinely orphaned
      issueLabels: makeIssueLabels({ 66: ["harness:in-progress"] }),
      counter: makeFakeCounter({ 66: 0 }), // 0 < retryCeilingK (2)
      gh,
      runLock,
    })
  );

  assert.ok(
    ghCalls.some(
      (args) =>
        args.includes(String(66)) && args.includes("--add-label") && args.includes("harness:ready")
    ),
    "a true orphan (no PR, not in-review) must still be relabeled to harness:ready — existing crash-recovery behavior unchanged"
  );
  assert.ok(
    releaseCalls.some((args) => args.acquireTs === 50_000),
    "the stale run-lock holder must still be released for a true orphan"
  );
});

test("reaper: sweepOrphanTopics SKIPS closing the topic when the issue's PR is still OPEN (#ac-1.2)", () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-900.json",
    meta: {
      issueNumber: 900,
      threadId: 900,
      worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-900",
      status: "awaiting-review",
    },
  };

  const { closeForumTopic, calls: closeCalls } = makeCloseForumTopic();
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [], // the run's worktree is NOT live -> genuine orphan candidate
      prOpen: (issueNumber) => issueNumber === 900,
      closeForumTopic,
      updateMeta,
    })
  );

  assert.equal(closeCalls.length, 0, "an open PR must SKIP the forum-topic close entirely");
  assert.ok(
    !updateCalls.some((c) => c.partial.status === "closed"),
    "an open PR must NEVER cause updateMeta to write status:'closed'"
  );
});

test("reaper: sweepOrphanTopics CLOSES the topic when the issue's PR is NOT open (#ac-1.6)", () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-901.json",
    meta: {
      issueNumber: 901,
      threadId: 900,
      worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-901",
      status: "awaiting-review",
    },
  };

  const { closeForumTopic, calls: closeCalls } = makeCloseForumTopic();
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [], // the run's worktree is NOT live -> genuine orphan candidate
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
    })
  );

  assert.ok(
    closeCalls.some((c) => c.threadId === 900),
    "a non-open PR must close the forum topic with the run's threadId"
  );
  assert.ok(
    updateCalls.some((c) => c.partial.status === "closed"),
    "a non-open PR must write status:'closed' via updateMeta"
  );
});

test("reaper: sweepOrphanTopics reverts a FAILED close to the CAPTURED prior status, never the hardcoded literal 'active' (H6)", async () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-902.json",
    meta: {
      issueNumber: 902,
      threadId: 900,
      worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-902",
      status: "awaiting-review", // the PRIOR status the revert must restore
    },
  };

  const { closeForumTopic } = makeCloseForumTopic({ ok: false }); // failed close ack
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [], // the run's worktree is NOT live -> genuine orphan candidate
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
    })
  );

  await Promise.allSettled(actions.topicCloses ?? []);

  assert.ok(
    updateCalls.some((c) => c.partial.status === "awaiting-review"),
    "a failed close must revert to the CAPTURED prior status ('awaiting-review'), not a hardcoded literal"
  );
  assert.ok(
    !updateCalls.some((c) => c.partial.status === "active"),
    "a failed close must NEVER revert to the hardcoded literal 'active'"
  );
});

test("reaper: sweepMergedWorktrees SAFELY prunes a released-lock worktree when the branch is squash-merged (prMerged true, branchMerged false, issue closed, PR not open) — worktree removed WITH force, branch deleted, action descriptor marked completed-cleaned (#ac-1.1)", () => {
  const entry = makeEntry({
    issueNumber: 83,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-83",
    branch: "harness/83",
    holder: null,
    lockDirAgeSeconds: null,
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemoveDetailed();
  const { gitBranchDelete, calls: branchDeleteCalls } = makeGitBranchDelete();
  const { issueClosed } = makeIssueClosed(true);
  const { prMerged } = makePrMerged(true);
  const { branchMerged } = makeBranchMerged(false); // squash-merged: not an ancestor of main
  const { inspectWorktree } = makeInspectWorktree({ unmergedCommits: ["abc123 wip"], dirtyPaths: [] });

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set()), // own session harness-demo-project-83 absent
      prOpen: () => false,
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  const removed = removeCalls.find((c) => c.path === entry.worktreePath);
  assert.ok(removed, "the squash-merged worktree must be removed");
  assert.equal(removed.opts?.force, true, "a safely-pruned worktree must be removed WITH force");
  assert.ok(
    branchDeleteCalls.some((c) => c.branch === "harness/83"),
    "the squash-merged branch must be deleted"
  );
  assert.ok(
    actions.some((a) => a.issueNumber === 83 && a.action === "completed-cleaned"),
    "the returned actions must carry a completed-cleaned descriptor for issue 83"
  );
});

test("reaper: sweepMergedWorktrees FAILS CLOSED when branchMerged is unknown (null), even though prMerged alone would satisfy the safe-signal disjunction — the null short-circuits BEFORE the OR, so neither removal nor branch delete fires (#ac-1.1 guard)", () => {
  const entry = makeEntry({
    issueNumber: 83,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-83",
    branch: "harness/83",
    holder: null,
    lockDirAgeSeconds: null,
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemoveDetailed();
  const { gitBranchDelete, calls: branchDeleteCalls } = makeGitBranchDelete();
  const { issueClosed } = makeIssueClosed(true);
  const { prMerged } = makePrMerged(true); // load-bearing: alone this would satisfy workPreserved
  const { branchMerged } = makeBranchMerged(null); // git merge-base exit 128 -> unknown
  const { inspectWorktree } = makeInspectWorktree({ unmergedCommits: ["abc123 wip"], dirtyPaths: [] });

  reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set()),
      prOpen: () => false,
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  assert.equal(removeCalls.length, 0, "an unknown branchMerged must skip the prune — no gitWorktreeRemove");
  assert.equal(branchDeleteCalls.length, 0, "an unknown branchMerged must skip the prune — no gitBranchDelete");
});

test("reaper: sweepMergedWorktrees treats a released-lock worktree (holder null) as LIVE when its OWN tmux session harness-<project>-<issue> is alive — no removal even with every other safe signal green (#ac-1.2)", () => {
  const entry = makeEntry({
    issueNumber: 84,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-84",
    branch: "harness/84",
    holder: null,
    lockDirAgeSeconds: null,
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemoveDetailed();
  const { gitBranchDelete, calls: branchDeleteCalls } = makeGitBranchDelete();
  const { issueClosed } = makeIssueClosed(true);
  const { prMerged } = makePrMerged(true);
  const { branchMerged } = makeBranchMerged(false);
  const { inspectWorktree } = makeInspectWorktree({ unmergedCommits: ["abc123 wip"], dirtyPaths: [] });

  reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set(["harness-demo-project-84"])), // own session alive
      prOpen: () => false,
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  assert.equal(removeCalls.length, 0, "a live own tmux session must block the worktree removal");
  assert.equal(branchDeleteCalls.length, 0, "a live own tmux session must block the branch delete");
});

test("reaper: sweepMergedWorktrees removes an UNSAFE released-lock worktree WITHOUT force and KEEPS the branch when neither prMerged nor branchMerged is true (#ac-1.3)", () => {
  const entry = makeEntry({
    issueNumber: 85,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-85",
    branch: "harness/85",
    holder: null,
    lockDirAgeSeconds: null,
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemoveDetailed();
  const { gitBranchDelete, calls: branchDeleteCalls } = makeGitBranchDelete();
  const { issueClosed } = makeIssueClosed(true);
  const { prMerged } = makePrMerged(false);
  const { branchMerged } = makeBranchMerged(false);
  const { inspectWorktree } = makeInspectWorktree({ unmergedCommits: ["abc123 wip"], dirtyPaths: [] });

  reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set()),
      prOpen: () => false,
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  const removed = removeCalls.find((c) => c.path === entry.worktreePath);
  assert.ok(removed, "an unsafe worktree must still be removed");
  assert.notEqual(removed.opts?.force, true, "an unsafe removal must NOT pass { force: true }");
  assert.equal(branchDeleteCalls.length, 0, "an unsafe removal must NEVER delete the branch");
});

test("reaper: sweepMergedWorktrees records the unmerged commits on the action descriptor (field unmergedCommits) before removing an unsafe worktree (#ac-1.3)", () => {
  const entry = makeEntry({
    issueNumber: 85,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-85",
    branch: "harness/85",
    holder: null,
    lockDirAgeSeconds: null,
  });

  const { gitWorktreeRemove } = makeGitWorktreeRemoveDetailed();
  const { gitBranchDelete } = makeGitBranchDelete();
  const { issueClosed } = makeIssueClosed(true);
  const { prMerged } = makePrMerged(false);
  const { branchMerged } = makeBranchMerged(false);
  const { inspectWorktree } = makeInspectWorktree({ unmergedCommits: ["abc123 wip"], dirtyPaths: [] });

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set()),
      prOpen: () => false,
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  const descriptor = actions.find((a) => a.issueNumber === 85);
  assert.ok(descriptor, "the unsafe worktree must produce an action descriptor");
  assert.deepEqual(
    descriptor.unmergedCommits,
    ["abc123 wip"],
    "the descriptor must carry the inspected unmerged commits under the unmergedCommits field"
  );
});

test("reaper: the NEW released-lock sweep is entered ONLY when lockDirAgeSeconds == null — the EXISTING orphan-lock path (lockDirAgeSeconds >= grace) still fires and never probes any of the four new seams (#ac-1.4)", () => {
  const entry = makeEntry({
    issueNumber: 86,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-86",
    branch: "harness/86",
    holder: null,
    lockDirAgeSeconds: 200, // >= the 120s registration grace -> the EXISTING orphan-lock branch
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemove();
  const { gitBranchDelete, calls: branchDeleteCalls } = makeGitBranchDelete();
  const { issueClosed, calls: issueClosedCalls } = makeIssueClosed(true);
  const { prMerged, calls: prMergedCalls } = makePrMerged(true);
  const { branchMerged, calls: branchMergedCalls } = makeBranchMerged(false);
  const { inspectWorktree, calls: inspectWorktreeCalls } = makeInspectWorktree({ unmergedCommits: [], dirtyPaths: [] });

  reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set()),
      prOpen: () => false,
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  assert.ok(removeCalls.includes(entry.worktreePath), "the existing orphan-lock path must still remove the worktree");
  assert.ok(
    branchDeleteCalls.some((c) => c.branch === "harness/86"),
    "the existing orphan-lock path must still delete the branch"
  );
  assert.equal(issueClosedCalls.length, 0, "an orphan-lock entry must never probe issueClosed");
  assert.equal(prMergedCalls.length, 0, "an orphan-lock entry must never probe prMerged");
  assert.equal(branchMergedCalls.length, 0, "an orphan-lock entry must never probe branchMerged");
  assert.equal(inspectWorktreeCalls.length, 0, "an orphan-lock entry must never probe inspectWorktree");
});

test("reaper: sweepMergedWorktrees prunes safely even when lockDirAgeSeconds is OMITTED entirely (undefined — the real listWorktrees() production shape, since run-reaper's seam never wires a lockDirAgeSeconds value); a strict === null entry guard would pass every other test here and be permanently dead in production (#ac-1.1)", () => {
  const entry = makeEntry({
    issueNumber: 87,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-87",
    branch: "harness/87",
    holder: null,
  });
  delete entry.lockDirAgeSeconds; // guarantee the key truly does not exist, not merely null

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemoveDetailed();
  const { gitBranchDelete, calls: branchDeleteCalls } = makeGitBranchDelete();
  const { issueClosed } = makeIssueClosed(true);
  const { prMerged } = makePrMerged(true);
  const { branchMerged } = makeBranchMerged(false);
  const { inspectWorktree } = makeInspectWorktree({ unmergedCommits: [], dirtyPaths: [] });

  reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set()),
      prOpen: () => false,
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  const removed = removeCalls.find((c) => c.path === entry.worktreePath);
  assert.ok(removed, "an omitted lockDirAgeSeconds key must still enter the released-lock sweep");
  assert.equal(removed.opts?.force, true, "the safe prune must still pass { force: true }");
  assert.ok(
    branchDeleteCalls.some((c) => c.branch === "harness/87"),
    "the safe prune must still delete the branch"
  );
});

test("reaper: sweepMergedWorktrees KEEPS the branch when the issue's PR is still OPEN — an open PR fails the !prOpen safe gate and falls to the #ac-1.3 keep-branch handling even with work provably preserved, because cron-a-dispatch's resume probe reads the LOCAL ref and deleting it would orphan the open PR's commits on re-dispatch (#ac-1.1 guard)", () => {
  const entry = makeEntry({
    issueNumber: 88,
    worktreePath: "/root/dev/demo-project/.worktrees/harness-demo-project-88",
    branch: "harness/88",
    holder: null,
    lockDirAgeSeconds: null,
  });

  const { gitWorktreeRemove, calls: removeCalls } = makeGitWorktreeRemoveDetailed();
  const { gitBranchDelete, calls: branchDeleteCalls } = makeGitBranchDelete();
  const { issueClosed } = makeIssueClosed(true);
  const { prMerged } = makePrMerged(false);
  const { branchMerged } = makeBranchMerged(false);
  const { inspectWorktree } = makeInspectWorktree({ unmergedCommits: [], dirtyPaths: [] });

  reaper(
    baseOpts({
      listWorktrees: () => [entry],
      tmuxHasSession: makeTmuxHasSession(new Set()),
      prOpen: () => true, // the open PR itself
      issueClosed,
      prMerged,
      branchMerged,
      inspectWorktree,
      gitWorktreeRemove,
      gitBranchDelete,
    })
  );

  assert.equal(branchDeleteCalls.length, 0, "an open PR must NEVER have its branch deleted");
  const removed = removeCalls.find((c) => c.path === entry.worktreePath);
  assert.ok(removed, "the worktree must still be removed even with an open PR");
  assert.notEqual(removed.opts?.force, true, "an open PR keep-branch removal must NOT pass { force: true }");
});

test("reaper: sweepOrphanTopics stamps closedAt from opts.now() in SECONDS on an optimistic close (#ac-1.11)", () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-903.json",
    meta: {
      issueNumber: 903,
      threadId: 5,
      worktreePath: "/gone",
      status: "active",
    },
  };

  const { closeForumTopic } = makeCloseForumTopic({ ok: true });
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [], // /gone is absent from the live set -> genuine orphan candidate
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
      now: () => 1700000000,
    })
  );

  const closedCall = updateCalls.find((c) => c.partial && c.partial.status === "closed");
  assert.ok(closedCall, "the optimistic close must write status:'closed' via updateMeta");
  assert.equal(closedCall.partial.closedAt, 1700000000, "closedAt must equal the injected now() value");
  assert.ok(closedCall.partial.closedAt < 1e12, "closedAt must be in SECONDS (< 1e12), never Date.now() milliseconds");
});

test("reaper: sweepOrphanTopics reverts a FAILED close to the captured prior status AND clears the closedAt fossil (#ac-1.7)", async () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-904.json",
    meta: {
      issueNumber: 904,
      threadId: 5,
      worktreePath: "/gone",
      status: "awaiting-review",
    },
  };

  const { closeForumTopic } = makeCloseForumTopic({ ok: false }); // failed close ack
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [], // /gone is absent from the live set -> genuine orphan candidate
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
      now: () => 1700000000,
    })
  );

  await Promise.allSettled(actions.topicCloses ?? []);

  const revertCall = updateCalls[updateCalls.length - 1];
  assert.deepEqual(
    revertCall.partial,
    { status: "awaiting-review", closedAt: null },
    "the revert partial must restore the captured prior status AND clear the closedAt fossil, nothing else"
  );
});

// ---------------------------------------------------------------------------
// #235/task-3: a permanent thread-not-found close KEEPS the optimistic status:'closed' (no revert);
// a transient failure still reverts (today's behavior preserved).
// ---------------------------------------------------------------------------

test("#235/task-3 reaper: sweepOrphanTopics KEEPS status:'closed' (no revert) when closeForumTopic resolves {ok:false, reason:'thread-not-found'}", async () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-905.json",
    meta: {
      issueNumber: 905,
      threadId: 5,
      worktreePath: "/gone",
      status: "awaiting-review",
    },
  };

  const { closeForumTopic } = makeCloseForumTopic({ ok: false, reason: "thread-not-found" });
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [],
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
      now: () => 1700000000,
    })
  );

  await Promise.allSettled(actions.topicCloses ?? []);

  assert.ok(
    !updateCalls.some((c) => c.partial.status === "awaiting-review"),
    "a thread-not-found close must NEVER revert to the prior status — the topic is already gone, that IS the terminal state"
  );
  const closedCall = updateCalls.find((c) => c.partial.status === "closed");
  assert.ok(closedCall, "the final on-disk state must be status:'closed'");
  assert.ok(
    updateCalls.some((c) => c.partial.topicConfirmedGone === true),
    "a thread-not-found close must ALSO flag topicConfirmedGone so drainTelegramOutbox's isFallback routes any remaining cosmetic event to the shared topic instead of retrying this dead threadId forever"
  );
});

test("#235/final-review reaper: sweepOrphanTopics does NOT flag topicConfirmedGone when closeForumTopic resolves {ok:true} (the topic still exists, merely archived — no regression)", async () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-908.json",
    meta: {
      issueNumber: 908,
      threadId: 5,
      worktreePath: "/gone",
      status: "active",
    },
  };

  const { closeForumTopic } = makeCloseForumTopic({ ok: true });
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [],
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
    })
  );

  await Promise.allSettled(actions.topicCloses ?? []);

  assert.ok(
    !updateCalls.some((c) => c.partial.topicConfirmedGone),
    "an ok:true close must NEVER flag topicConfirmedGone — the topic still exists, so it must keep targeting its own thread"
  );
});

test("#235/task-3 reaper: sweepOrphanTopics STILL reverts to the prior status when closeForumTopic resolves {ok:false, reason:'transient'} (today's behavior preserved)", async () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-906.json",
    meta: {
      issueNumber: 906,
      threadId: 5,
      worktreePath: "/gone",
      status: "awaiting-review",
    },
  };

  const { closeForumTopic } = makeCloseForumTopic({ ok: false, reason: "transient" });
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [],
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
    })
  );

  await Promise.allSettled(actions.topicCloses ?? []);

  assert.ok(
    updateCalls.some((c) => c.partial.status === "awaiting-review"),
    "a transient close failure must still revert to the captured prior status"
  );
});

test("#235/task-3 reaper: sweepOrphanTopics KEEPS status:'closed' (no revert) when closeForumTopic resolves {ok:true}", async () => {
  const run = {
    metaPath: "/root/dev/demo-project/.claude/state/obs-907.json",
    meta: {
      issueNumber: 907,
      threadId: 5,
      worktreePath: "/gone",
      status: "active",
    },
  };

  const { closeForumTopic } = makeCloseForumTopic({ ok: true });
  const { updateMeta, calls: updateCalls } = makeUpdateMeta();

  const actions = reaper(
    baseOpts({
      listWorktrees: () => [],
      listObsRuns: () => [run],
      liveWorktreePaths: () => [],
      prOpen: () => false,
      closeForumTopic,
      updateMeta,
    })
  );

  await Promise.allSettled(actions.topicCloses ?? []);

  assert.ok(
    !updateCalls.some((c) => c.partial.status === "active"),
    "a successful close must never revert — no regression"
  );
});
