/**
 * @description Contract tests for cron-a-exit.mjs (task-6) — the VPS cron harness's
 * graceful-exit state machine. cronAExit() is chained AFTER `claude -p` inside the tmux
 * session dispatch (task-5) spawns, and fires on the session's OWN termination:
 *
 *   - PR exists on harness/<issue>                              -> harness:in-review
 *   - no PR + a recorded deliberate blocking finding             -> harness:blocked (+ comment)
 *   - no PR, no blocking record, attempt counter < retryCeilingK -> harness:ready (re-queue)
 *   - no PR, no blocking record, attempt counter >= retryCeilingK -> harness:blocked (ceiling)
 *
 * It is a READ-ONLY comparator of the per-issue attempt counter (never calls increment() —
 * dispatch owns charging attempts); it does NOT reset() on the PR-exists path (the done+reset
 * moved to the post-merge review phase). It always releases the run-lock and always unlinks the
 * body-file + env-file (issue body + scoped secrets) on every exit path.
 *
 * Every seam cronAExit needs — `gh`, the run-lock release, the attempt counter, whether a PR
 * was opened, and whether a blocking finding was recorded — is INJECTED as a fake so these
 * tests are fully hermetic: no real gh/git process is ever spawned. The body-file/env-file
 * unlink assertions use REAL temp files (mkdtemp under os.tmpdir()) so file removal is an
 * observable via fs.existsSync, per this repo's hermetic style (see run-lock.test.mjs).
 *
 * notifyExit() tests (below the cronAExit contract tests) exercise the observability path — the
 * translation of a cronAExit structured outcome into the run's terminal lifecycle signal — with
 * every seam (env, prLookup, makeNotifier, appendEvent, closeForumTopic, readMeta, updateMeta)
 * injected as a fake, and a REAL temp meta file backing HARNESS_OBSERVABILITY_RUN_PATH so the
 * production existsSync guard observes a real file (per this file's hermetic style).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { cronAExit, notifyExit } from "./cron-a-exit.mjs";

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

/** @description Fake appendEvent seam for notifyExit; records every (metaPath, event) call. */
function makeFakeAppendEvent() {
  const calls = [];
  function appendEvent(metaPath, event) {
    calls.push({ metaPath, event });
  }
  return { appendEvent, calls };
}

/** @description Fake closeForumTopic seam for notifyExit; records every (input, opts) call. */
function makeFakeCloseForumTopic(result = { ok: true }) {
  const calls = [];
  async function closeForumTopic(input, opts) {
    calls.push({ input, opts });
    return result;
  }
  return { closeForumTopic, calls };
}

/** @description Fake readMeta seam for notifyExit; always returns the given meta object. */
function makeFakeReadMeta(meta) {
  return () => meta;
}

/** @description Fake updateMeta seam for notifyExit; records every (metaPath, partial) call. */
function makeFakeUpdateMeta() {
  const calls = [];
  function updateMeta(metaPath, partial) {
    calls.push({ metaPath, partial });
  }
  return { updateMeta, calls };
}

/** @description Fake makeNotifier seam for notifyExit; returns a stable stub notifier. */
function makeFakeMakeNotifier() {
  return () => ({ config: {}, notify: () => {}, drain: async () => {} });
}

/**
 * @description Creates a REAL temp meta file (so the production existsSync guard on
 * HARNESS_OBSERVABILITY_RUN_PATH observes a real file) and returns its path plus cleanup. The
 * file's contents are irrelevant to these tests — readMeta is always injected as a fake — only
 * its existence matters for the obsEnabled gate.
 */
function makeObsRunPath() {
  const root = mkdtempSync(join(tmpdir(), "cron-a-exit-obs-"));
  const runPath = join(root, "obs-42.json");
  writeFileSync(runPath, JSON.stringify({ threadId: 555, status: "active" }), "utf8");
  return { runPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("cronAExit: PR exists on harness/42 -> relabels harness:in-progress -> harness:in-review; no path leaves the issue in harness:in-progress", () => {
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

    const inReviewRelabel = findRelabelCall(calls, {
      removeLabel: "harness:in-progress",
      addLabel: "harness:in-review",
    });
    assert.ok(inReviewRelabel, "must relabel harness:in-progress -> harness:in-review when a PR exists on harness/42");
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

test("cronAExit: increment() is NEVER called on any exit path (done/blocked/ready)", () => {
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

test("cronAExit: PR exists on harness/42 -> the captured `gh issue edit` argv adds harness:in-review and NEVER harness:done", () => {
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

    assert.equal(
      anyRelabelAdds(calls, "harness:in-review"),
      true,
      "the PR-exists path must relabel by adding harness:in-review"
    );

    const anyCallMentionsDone = calls.some((args) => Array.isArray(args) && args.includes("harness:done"));
    assert.equal(
      anyCallMentionsDone,
      false,
      "no gh call on the PR-exists path may ever reference harness:done"
    );
  } finally {
    cleanup();
  }
});

test("cronAExit: PR exists on harness/42 -> counter.reset is NOT called on the PR-exists path", () => {
  const { stateDir, cleanup } = makeTempDirs();
  try {
    const { gh } = makeFakeGh();
    const runLock = makeFakeRunLock();
    const counter = makeFakeCounter({ 42: 1 });

    cronAExit(
      42,
      "/fake/worktree",
      join(stateDir, "issue-42-body.txt"),
      join(stateDir, "issue-42-env.env"),
      baseOpts({ stateDir, gh, runLock, counter, prExists: () => true, blockingFinding: () => null })
    );

    assert.deepEqual(
      counter.resetCalls,
      [],
      "counter.reset must never be called on the PR-exists (harness:in-review) path"
    );
  } finally {
    cleanup();
  }
});

test("cronAExit: PR exists on harness/42 -> `gh label create harness:in-review --force` runs BEFORE the `gh issue edit ... --add-label harness:in-review` relabel", () => {
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

    const labelCreateIndex = calls.findIndex(
      (args) =>
        Array.isArray(args) &&
        args[0] === "label" &&
        args[1] === "create" &&
        args[2] === "harness:in-review" &&
        args.includes("--force")
    );
    const relabelIndex = calls.findIndex(
      (args) =>
        Array.isArray(args) &&
        args[0] === "issue" &&
        args[1] === "edit" &&
        args.includes("--add-label") &&
        args[args.indexOf("--add-label") + 1] === "harness:in-review"
    );

    assert.notEqual(labelCreateIndex, -1, "must call `gh label create harness:in-review --force`");
    assert.notEqual(relabelIndex, -1, "must call `gh issue edit ... --add-label harness:in-review`");
    assert.ok(
      labelCreateIndex < relabelIndex,
      "the label-create call must happen BEFORE the issue-edit relabel call"
    );
  } finally {
    cleanup();
  }
});

test("notifyExit: 'done' outcome on the observability path keeps the forum topic OPEN (never calls closeForumTopic) and sets status 'awaiting-review'", async () => {
  const { runPath, cleanup } = makeObsRunPath();
  try {
    const { appendEvent } = makeFakeAppendEvent();
    const { closeForumTopic, calls: closeCalls } = makeFakeCloseForumTopic();
    const readMeta = makeFakeReadMeta({ threadId: 555, status: "active" });
    const { updateMeta, calls: updateCalls } = makeFakeUpdateMeta();
    const makeNotifierFake = makeFakeMakeNotifier();

    await notifyExit(
      { outcome: "done", issueNumber: 42, hadPr: true, finding: null },
      {
        env: { HOME: "/fake/home", HARNESS_OBSERVABILITY_RUN_PATH: runPath },
        prLookup: () => ({ number: 7, url: "https://example.test/pr/7" }),
        makeNotifier: makeNotifierFake,
        appendEvent,
        closeForumTopic,
        readMeta,
        updateMeta,
      }
    );

    assert.equal(
      closeCalls.length,
      0,
      "the 'done' outcome must never close the forum topic — it stays open pending review"
    );

    const awaitingReviewCall = updateCalls.find(
      (call) => call.partial && call.partial.status === "awaiting-review"
    );
    assert.ok(
      awaitingReviewCall,
      "updateMeta must be called with a partial whose status === 'awaiting-review' on the 'done' outcome"
    );
  } finally {
    cleanup();
  }
});

test("notifyExit: 'done' outcome still produces the PR checkpoint via appendEvent", async () => {
  const { runPath, cleanup } = makeObsRunPath();
  try {
    const { appendEvent, calls: appendCalls } = makeFakeAppendEvent();
    const { closeForumTopic } = makeFakeCloseForumTopic();
    const readMeta = makeFakeReadMeta({ threadId: 555, status: "active" });
    const { updateMeta } = makeFakeUpdateMeta();
    const makeNotifierFake = makeFakeMakeNotifier();

    await notifyExit(
      { outcome: "done", issueNumber: 42, hadPr: true, finding: null },
      {
        env: { HOME: "/fake/home", HARNESS_OBSERVABILITY_RUN_PATH: runPath },
        prLookup: () => ({ number: 7, url: "https://example.test/pr/7" }),
        makeNotifier: makeNotifierFake,
        appendEvent,
        closeForumTopic,
        readMeta,
        updateMeta,
      }
    );

    const prEventCall = appendCalls.find((call) => call.event && call.event.type === "PR");
    assert.ok(prEventCall, "appendEvent must be called with an event whose type === 'PR' on the 'done' outcome");
  } finally {
    cleanup();
  }
});

test("notifyExit: 'blocked' outcome with no PR STILL closes the forum topic and sets status 'closed' (no regression)", async () => {
  const { runPath, cleanup } = makeObsRunPath();
  try {
    const { appendEvent } = makeFakeAppendEvent();
    const { closeForumTopic, calls: closeCalls } = makeFakeCloseForumTopic();
    const readMeta = makeFakeReadMeta({ threadId: 555, status: "active" });
    const { updateMeta, calls: updateCalls } = makeFakeUpdateMeta();
    const makeNotifierFake = makeFakeMakeNotifier();
    const findingMessage = "Adversary flagged an unresolved security risk in the payment handler.";

    await notifyExit(
      { outcome: "blocked", issueNumber: 42, hadPr: false, finding: findingMessage },
      {
        env: { HOME: "/fake/home", HARNESS_OBSERVABILITY_RUN_PATH: runPath },
        prLookup: () => null,
        makeNotifier: makeNotifierFake,
        appendEvent,
        closeForumTopic,
        readMeta,
        updateMeta,
      }
    );

    const closeCall = closeCalls.find((call) => call.input && call.input.threadId === 555);
    assert.ok(closeCall, "closeForumTopic must be called with an input whose threadId === 555 on the 'blocked' outcome");

    const closedCall = updateCalls.find((call) => call.partial && call.partial.status === "closed");
    assert.ok(closedCall, "updateMeta must be called with a partial whose status === 'closed' on the 'blocked' outcome");
  } finally {
    cleanup();
  }
});

test("notifyExit: 'blocked' outcome with an open topic stamps closedAt from deps.now() in SECONDS, not milliseconds (#ac-1.11)", async () => {
  const { runPath, cleanup } = makeObsRunPath();
  try {
    const { appendEvent } = makeFakeAppendEvent();
    const { closeForumTopic } = makeFakeCloseForumTopic({ ok: true });
    const readMeta = makeFakeReadMeta({ status: "active", threadId: 707 });
    const { updateMeta, calls: updateCalls } = makeFakeUpdateMeta();
    const makeNotifierFake = makeFakeMakeNotifier();

    await notifyExit(
      { outcome: "blocked", issueNumber: 4201, finding: "x" },
      {
        env: { HOME: "/fake/home", HARNESS_OBSERVABILITY_RUN_PATH: runPath },
        prLookup: () => null,
        makeNotifier: makeNotifierFake,
        appendEvent,
        closeForumTopic,
        readMeta,
        updateMeta,
        now: () => 1700000000,
      }
    );

    const closedCall = updateCalls.find((call) => call.partial && call.partial.status === "closed");
    assert.ok(closedCall, "updateMeta must be called with a partial whose status === 'closed'");
    assert.equal(closedCall.partial.closedAt, 1700000000, "closedAt must equal the injected now() value");
    assert.ok(closedCall.partial.closedAt < 1e12, "closedAt must be in SECONDS (< 1e12), never Date.now() milliseconds");
  } finally {
    cleanup();
  }
});

test("notifyExit: 'failed' outcome with no forum topic (threadId null) stamps closedAt from deps.now() in SECONDS and never calls closeForumTopic (#ac-1.11)", async () => {
  const { runPath, cleanup } = makeObsRunPath();
  try {
    const { appendEvent } = makeFakeAppendEvent();
    const { closeForumTopic, calls: closeCalls } = makeFakeCloseForumTopic({ ok: true });
    const readMeta = makeFakeReadMeta({ status: "active", threadId: null });
    const { updateMeta, calls: updateCalls } = makeFakeUpdateMeta();
    const makeNotifierFake = makeFakeMakeNotifier();

    await notifyExit(
      { outcome: "failed", issueNumber: 4202 },
      {
        env: { HOME: "/fake/home", HARNESS_OBSERVABILITY_RUN_PATH: runPath },
        prLookup: () => null,
        makeNotifier: makeNotifierFake,
        appendEvent,
        closeForumTopic,
        readMeta,
        updateMeta,
        now: () => 1700000000,
      }
    );

    assert.equal(closeCalls.length, 0, "closeForumTopic must never be called when no forum topic was ever created (threadId null)");

    const closedCall = updateCalls.find((call) => call.partial && call.partial.status === "closed");
    assert.ok(closedCall, "updateMeta must be called with a partial whose status === 'closed'");
    assert.equal(closedCall.partial.closedAt, 1700000000, "closedAt must equal the injected now() value");
    assert.ok(closedCall.partial.closedAt < 1e12, "closedAt must be in SECONDS (< 1e12), never Date.now() milliseconds");
  } finally {
    cleanup();
  }
});
