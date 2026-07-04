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
  return (issueNumber) => issueNumbersWithPr.has(issueNumber);
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
