/**
 * @description Pinned contract tests for run-cron-review.mjs — the VPS cron harness's independent
 * PR-review COMPOSITION ROOT. This suite is intentionally RED until run-cron-review.mjs exists: it
 * pins the exact seam contract the executor must implement.
 *
 * Exported shape under test: `runCronReview(config, deps = {})`.
 *   - `config.stateDir` is the PROJECT's base state dir; the review phase gets its OWN, SEPARATE
 *     lock/state scope at `join(config.stateDir, "review")` — distinct from cron-a/cron-b's lock
 *     on the base `config.stateDir`, so the review cron and the select/merge crons never block
 *     each other.
 *   - `config.reviewEnabled === false` is the operator kill switch: when set, runCronReview
 *     returns WITHOUT ever calling `deps.cronReview` (no lock acquired, no gh call, no spawn).
 *   - Before acquiring the review lock, runCronReview checks `deps.breakerTripped({stateDir:
 *     <reviewStateDir>, now: deps.now})`: when tripped, it emits a `deps.notify(event)` call whose
 *     `event.type` names a breaker/stall condition and returns WITHOUT calling `deps.cronReview`.
 *   - `deps.breakerTripped` / `deps.recordReviewSession` DEFAULT to the REAL functions from
 *     `./cron-state.mjs`, scoped to the review stateDir — never a fake/no-op default — so the real
 *     BREAKER_MAX_SESSIONS-per-window cap (driven by real `recordReviewSession` calls made while
 *     spawning review sessions) is what actually gates production spawns.
 *   - Otherwise, runCronReview acquires the review lock (via `deps.runLock.acquire` on
 *     `join(config.stateDir, "review")`) and calls `deps.cronReview(opts)` — every other seam
 *     (`gh`, `isReviewEligible`, `getFreshVerdict`, `crossFamilyEligible`, `mergeAndFinalize`,
 *     `reconcile`, `routeReject`, `touchesGateMachinery`, `mergeEligible`, `spawnReviewSession`,
 *     `notify`, `stateDir`, `authenticatedUser`, `engineKnows`, `recordReviewSession`,
 *     `breakerTripped`, `alreadyReviewed`) is wired for cron-review.mjs's contract (see
 *     cron-review.test.mjs) — then releases the lock.
 *
 * Tests 1 and 4 use the REAL `./run-lock.mjs` and/or `./cron-state.mjs` functions against real
 * temp directories so the lock-separation and the per-session breaker cap are proven against
 * genuine filesystem state, never an injected already-true shortcut alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCronReview } from "./run-cron-review.mjs";
import { acquire, release } from "./run-lock.mjs";
import { recordReviewSession, breakerTripped } from "./cron-state.mjs";

const BASE_CONFIG = {
  project: "demo",
  owner: "acme",
  repo: "demo-repo",
  projectRoot: "/srv/demo",
  worktreeRoot: "/srv/worktrees",
  homeDir: "/home/harness",
};

/** @description Records every call into `.calls` (argv-array-per-call); optionally delegates to `impl`. */
function makeSpy(impl) {
  function fn(...args) {
    fn.calls.push(args);
    return impl ? impl(...args) : undefined;
  }
  fn.calls = [];
  return fn;
}

/** @description Creates a fresh temp stateDir for a test, and returns a cleanup callback. */
function withTempStateDir(prefix) {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test("run-cron-review: acquires a SEPARATE lock under join(stateDir, 'review') — a lock already held on the base stateDir never blocks it", () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-lock-");
  try {
    const now = () => 1_000_000;
    const kill = () => {}; // never throws -> "alive"
    const tmuxHasSession = () => false;

    const baseLock = acquire({ stateDir, pid: 111, now, kill, tmuxHasSession });
    assert.ok(baseLock.acquired, "precondition: acquiring the lock on the base stateDir must succeed");

    const cronReviewSpy = makeSpy(() => ({}));

    runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: cronReviewSpy,
        runLock: { acquire, release },
        notify: () => {},
        breakerTripped: () => false,
        recordReviewSession: () => {},
        now,
        kill,
        tmuxHasSession,
        pid: 222,
      }
    );

    assert.ok(
      cronReviewSpy.calls.length >= 1,
      "runCronReview's own lock on join(stateDir,'review') must acquire independently of the base stateDir's already-held lock, so cronReview still runs"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: kill switch OFF (config.reviewEnabled === false) exits WITHOUT spawning any review session", () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-kill-");
  try {
    const cronReviewSpy = makeSpy(() => ({}));

    runCronReview(
      { ...BASE_CONFIG, stateDir, reviewEnabled: false },
      {
        cronReview: cronReviewSpy,
        notify: () => {},
      }
    );

    assert.equal(
      cronReviewSpy.calls.length,
      0,
      "with the kill switch off, cronReview (and therefore every review session it would spawn) must never be invoked"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: circuit-breaker tripped for the window stops spawning AND emits a notification", () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-breaker-");
  try {
    const cronReviewSpy = makeSpy(() => ({}));
    const notifySpy = makeSpy();

    runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: cronReviewSpy,
        breakerTripped: () => true,
        recordReviewSession: () => {},
        notify: notifySpy,
      }
    );

    assert.equal(
      cronReviewSpy.calls.length,
      0,
      "a tripped breaker must stop the whole cycle before any spawn is attempted"
    );
    assert.ok(
      notifySpy.calls.some(([event]) => /breaker|stall/i.test(String(event && event.type))),
      "a breaker/stall notification event must be emitted when the breaker blocks the cycle"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: the breaker cap is reached by REAL per-session increments, not an injected already-tripped flag", () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-realcap-");
  try {
    const reviewStateDir = join(stateDir, "review");
    const now = () => 2_000_000;

    // Seed the REAL breaker state with 12 genuinely-recorded sessions this window (the documented
    // BREAKER_MAX_SESSIONS in cron-state.mjs) — driving the cap via real per-session increments,
    // never a fabricated tripped flag.
    for (let i = 0; i < 12; i += 1) {
      recordReviewSession({ stateDir: reviewStateDir, now });
    }
    assert.ok(
      breakerTripped({ stateDir: reviewStateDir, now }),
      "sanity precondition: 12 real recorded sessions this window must trip the real breaker"
    );

    const cronReviewSpy = makeSpy(() => ({}));
    const notifySpy = makeSpy();

    runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: cronReviewSpy,
        notify: notifySpy,
        now,
        // breakerTripped / recordReviewSession intentionally OMITTED here — they must default to
        // the REAL cron-state functions scoped to join(stateDir, "review"), so the real state
        // seeded above is what actually gates this (K+1)th attempt.
      }
    );

    assert.equal(
      cronReviewSpy.calls.length,
      0,
      "the (K+1)th spawn attempt must be blocked once the REAL per-session count reaches the breaker cap"
    );
    assert.ok(
      notifySpy.calls.some(([event]) => /breaker|stall/i.test(String(event && event.type))),
      "a breaker/stall notification event must be emitted when the real cap blocks the cycle"
    );
  } finally {
    cleanup();
  }
});
