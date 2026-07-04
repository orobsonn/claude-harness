/**
 * @description Contract tests for cron-a-exit.mjs (task-6) — the VPS cron harness's
 * graceful-exit state machine. cronAExit() is chained AFTER `claude -p` inside the tmux
 * session dispatch (task-5) spawns, and fires on the session's OWN termination:
 *
 *   - PR exists on harness/<issue>                              -> harness:done
 *   - no PR + a recorded deliberate blocking finding             -> harness:blocked (+ comment)
 *   - no PR, no blocking record, attempt counter < retryCeilingK -> harness:ready (re-queue)
 *   - no PR, no blocking record, attempt counter >= retryCeilingK -> harness:blocked (ceiling)
 *
 * It is a READ-ONLY comparator of the per-issue attempt counter (never calls increment() —
 * dispatch owns charging attempts), except it calls reset() on the done path. It always
 * releases the run-lock and always unlinks the body-file + env-file (issue body + scoped
 * secrets) on every exit path.
 *
 * Every seam cronAExit needs — `gh`, the run-lock release, the attempt counter, whether a PR
 * was opened, and whether a blocking finding was recorded — is INJECTED as a fake so these
 * tests are fully hermetic: no real gh/git process is ever spawned. The body-file/env-file
 * unlink assertions use REAL temp files (mkdtemp under os.tmpdir()) so file removal is an
 * observable via fs.existsSync, per this repo's hermetic style (see run-lock.test.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cronAExit } from "./cron-a-exit.mjs";

const RETRY_CEILING_K = 2;

/** @description Fresh temp state dir for one test, plus cleanup. */
function makeTempDirs() {
  const root = mkdtempSync(join(tmpdir(), "cron-a-exit-"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** @description Fake gh seam. Records each `gh` argv (e.g. `["issue","edit",...]`). */
function makeFakeGh() {
  const calls = [];
  function gh(args) {
    calls.push(args);
    return { ok: true };
  }
  return { gh, calls };
}

/** @description Fake run-lock seam exposing only release() — cronAExit never re-acquires. */
function makeFakeRunLock() {
  const releaseCalls = [];
  return {
    release(opts) {
      releaseCalls.push(opts);
    },
    releaseCalls,
  };
}

/**
 * @description Fake per-issue attempt-counter seam mirroring cron-state.mjs's
 * read/reset/increment contract, backed by an in-memory map. Tracks every increment()/reset()
 * call so a test can assert cronAExit is READ-ONLY on the counter (never increments).
 */
function makeFakeCounter(initial = {}) {
  const counts = { ...initial };
  const incrementCalls = [];
  const resetCalls = [];
  return {
    read(issueNumber) {
      return counts[issueNumber] ?? 0;
    },
    reset(issueNumber) {
      resetCalls.push(issueNumber);
      counts[issueNumber] = 0;
    },
    increment(issueNumber) {
      incrementCalls.push(issueNumber);
      counts[issueNumber] = (counts[issueNumber] ?? 0) + 1;
    },
    incrementCalls,
    resetCalls,
  };
}

/** @description Assembles a full cronAExit() opts object from defaults + per-test overrides. */
function baseOpts({ stateDir, gh, runLock, counter, prExists, blockingFinding, acquireTs = 1000 }) {
  return {
    gh,
    runLock,
    counter,
    prExists,
    blockingFinding,
    stateDir,
    acquireTs,
    retryCeilingK: RETRY_CEILING_K,
  };
}

/** @description Finds a `gh issue edit <n> --remove-label X --add-label Y` call in a calls log. */
function findRelabelCall(calls, { removeLabel, addLabel }) {
  return calls.find(
    (args) =>
      Array.isArray(args) &&
      args[0] === "issue" &&
      args[1] === "edit" &&
      args.includes("--remove-label") &&
      args[args.indexOf("--remove-label") + 1] === removeLabel &&
      args.includes("--add-label") &&
      args[args.indexOf("--add-label") + 1] === addLabel
  );
}

/** @description Finds a `gh issue comment <issueNumber> ...` call in a calls log. */
function findCommentCall(calls, issueNumber) {
  return calls.find(
    (args) =>
      Array.isArray(args) && args[0] === "issue" && args[1] === "comment" && args[2] === String(issueNumber)
  );
}

/** @description True if any recorded gh call adds the given label (regardless of which call). */
function anyRelabelAdds(calls, label) {
  return calls.some(
    (args) => Array.isArray(args) && args.includes("--add-label") && args[args.indexOf("--add-label") + 1] === label
  );
}

test("cronAExit: PR exists on harness/42 -> relabels harness:in-progress -> harness:done; no path leaves the issue in harness:in-progress", () => {
  const { stateDir, cleanup } = makeTempDirs();
  try {
    const { gh, calls } = makeFakeGh();
    const runLock = makeFakeRunLock();
    const counter = makeFakeCounter({ 42: 1 });

    cronAExit(
      42,
      "/fake/worktree",
      join(stateDir, "issue-42-body.txt"),
      join(stateDir, "issue-42-env.env"),
      baseOpts({ stateDir, gh, runLock, counter, prExists: () => true, blockingFinding: () => null })
    );

    const doneRelabel = findRelabelCall(calls, { removeLabel: "harness:in-progress", addLabel: "harness:done" });
    assert.ok(doneRelabel, "must relabel harness:in-progress -> harness:done when a PR exists on harness/42");
    assert.equal(
      anyRelabelAdds(calls, "harness:in-progress"),
      false,
      "no gh call may leave (or put back) the issue in harness:in-progress"
    );
  } finally {
    cleanup();
  }
});

test("cronAExit: no PR + a recorded deliberate blocking finding -> relabels harness:blocked and posts the blocking comment; never relabels harness:ready", () => {
  const { stateDir, cleanup } = makeTempDirs();
  try {
    const { gh, calls } = makeFakeGh();
    const runLock = makeFakeRunLock();
    const counter = makeFakeCounter({ 42: 0 });
    const findingMessage = "Adversary flagged an unresolved security risk in the payment handler.";

    cronAExit(
      42,
      "/fake/worktree",
      join(stateDir, "issue-42-body.txt"),
      join(stateDir, "issue-42-env.env"),
      baseOpts({
        stateDir,
        gh,
        runLock,
        counter,
        prExists: () => false,
        blockingFinding: () => findingMessage,
      })
    );

    const blockedRelabel = findRelabelCall(calls, {
      removeLabel: "harness:in-progress",
      addLabel: "harness:blocked",
    });
    assert.ok(blockedRelabel, "must relabel harness:in-progress -> harness:blocked on a deliberate blocking finding");

    const commentCall = findCommentCall(calls, 42);
    assert.ok(commentCall, "must post the blocking comment via `gh issue comment 42`");
    assert.ok(
      commentCall.join(" ").includes(findingMessage),
      "the posted comment must carry the recorded blocking finding message"
    );

    assert.equal(
      anyRelabelAdds(calls, "harness:ready"),
      false,
      "a deliberately-blocked issue must never be silently re-queued to harness:ready"
    );
  } finally {
    cleanup();
  }
});

test("cronAExit: no PR, no blocking record, attempt counter for 42 = 1 (< K=2) -> relabels harness:ready (re-queue)", () => {
  const { stateDir, cleanup } = makeTempDirs();
  try {
    const { gh, calls } = makeFakeGh();
    const runLock = makeFakeRunLock();
    const counter = makeFakeCounter({ 42: 1 });

    cronAExit(
      42,
      "/fake/worktree",
      join(stateDir, "issue-42-body.txt"),
      join(stateDir, "issue-42-env.env"),
      baseOpts({ stateDir, gh, runLock, counter, prExists: () => false, blockingFinding: () => null })
    );

    const readyRelabel = findRelabelCall(calls, { removeLabel: "harness:in-progress", addLabel: "harness:ready" });
    assert.ok(readyRelabel, "must re-queue to harness:ready while the attempt counter is below the retry ceiling K");
  } finally {
    cleanup();
  }
});

test("cronAExit: no PR, no blocking record, attempt counter for 42 already = 2 (>= K=2) -> relabels harness:blocked, NOT harness:ready", () => {
  const { stateDir, cleanup } = makeTempDirs();
  try {
    const { gh, calls } = makeFakeGh();
    const runLock = makeFakeRunLock();
    const counter = makeFakeCounter({ 42: 2 });

    cronAExit(
      42,
      "/fake/worktree",
      join(stateDir, "issue-42-body.txt"),
      join(stateDir, "issue-42-env.env"),
      baseOpts({ stateDir, gh, runLock, counter, prExists: () => false, blockingFinding: () => null })
    );

    const blockedRelabel = findRelabelCall(calls, {
      removeLabel: "harness:in-progress",
      addLabel: "harness:blocked",
    });
    assert.ok(
      blockedRelabel,
      "must relabel harness:blocked once the attempt counter has reached/exceeded the retry ceiling K"
    );
    assert.equal(
      anyRelabelAdds(calls, "harness:ready"),
      false,
      "a chronically-failing issue at/above the retry ceiling must never be re-queued to harness:ready"
    );
  } finally {
    cleanup();
  }
});

test("cronAExit: the done path calls reset(42) so the persisted counter reads 0; increment() is NEVER called on any exit path (done/blocked/ready)", () => {
  const scenarios = [
    { name: "done", prExists: () => true, blockingFinding: () => null, initialCount: 1 },
    { name: "blocked-by-finding", prExists: () => false, blockingFinding: () => "blocking finding", initialCount: 0 },
    { name: "blocked-by-ceiling", prExists: () => false, blockingFinding: () => null, initialCount: 2 },
    { name: "ready", prExists: () => false, blockingFinding: () => null, initialCount: 0 },
  ];

  for (const scenario of scenarios) {
    const { stateDir, cleanup } = makeTempDirs();
    try {
      const { gh } = makeFakeGh();
      const runLock = makeFakeRunLock();
      const counter = makeFakeCounter({ 42: scenario.initialCount });

      cronAExit(
        42,
        "/fake/worktree",
        join(stateDir, "issue-42-body.txt"),
        join(stateDir, "issue-42-env.env"),
        baseOpts({
          stateDir,
          gh,
          runLock,
          counter,
          prExists: scenario.prExists,
          blockingFinding: scenario.blockingFinding,
        })
      );

      assert.equal(
        counter.incrementCalls.length,
        0,
        `cronAExit must never call increment() on the "${scenario.name}" exit path — it is a read-only ` +
          "comparator of the failure count, never a writer of it"
      );

      if (scenario.name === "done") {
        assert.deepEqual(counter.resetCalls, [42], "the done path must call reset(42) exactly once");
        assert.equal(counter.read(42), 0, "after the done path runs, the persisted counter must read 0");
      }
    } finally {
      cleanup();
    }
  }
});

test("cronAExit: unlinks the bodyFile and envFile on any exit path (done/blocked/ready), and releases the run-lock with the held acquireTs", () => {
  const scenarios = [
    { name: "done", prExists: () => true, blockingFinding: () => null },
    { name: "blocked", prExists: () => false, blockingFinding: () => "blocking finding" },
    { name: "ready", prExists: () => false, blockingFinding: () => null },
  ];

  for (const scenario of scenarios) {
    const { stateDir, cleanup } = makeTempDirs();
    try {
      const bodyFile = join(stateDir, "issue-42-body.txt");
      const envFile = join(stateDir, "issue-42-env.env");
      writeFileSync(bodyFile, "the issue body", "utf8");
      writeFileSync(envFile, "SOME_SECRET=abc123", "utf8");
      assert.ok(
        existsSync(bodyFile) && existsSync(envFile),
        `precondition (${scenario.name}): both bodyFile and envFile exist before cronAExit runs`
      );

      const { gh } = makeFakeGh();
      const runLock = makeFakeRunLock();
      const counter = makeFakeCounter({ 42: 0 });
      const acquireTs = 424242;

      cronAExit(
        42,
        "/fake/worktree",
        bodyFile,
        envFile,
        baseOpts({
          stateDir,
          gh,
          runLock,
          counter,
          prExists: scenario.prExists,
          blockingFinding: scenario.blockingFinding,
          acquireTs,
        })
      );

      assert.equal(existsSync(bodyFile), false, `bodyFile must be unlinked after the "${scenario.name}" exit path`);
      assert.equal(existsSync(envFile), false, `envFile must be unlinked after the "${scenario.name}" exit path`);

      assert.equal(runLock.releaseCalls.length, 1, "run-lock release must be called exactly once on exit");
      assert.equal(
        runLock.releaseCalls[0].acquireTs,
        acquireTs,
        "run-lock release must be called with the held holder's acquireTs"
      );
    } finally {
      cleanup();
    }
  }
});
