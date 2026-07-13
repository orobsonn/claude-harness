/**
 * @description Pinned contract tests for run-cron-review.mjs — the VPS cron harness's independent
 * PR-review COMPOSITION ROOT. This suite is intentionally RED until run-cron-review.mjs exists: it
 * pins the exact seam contract the executor must implement.
 *
 * Exported shape under test: `runCronReview(config, deps = {})` — now ASYNC (it awaits a one-time
 * codex-driver load at setup before dispatching to `deps.cronReview`).
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
 *     `reconcile`, `routeReject`, `spawnReviewSession`,
 *     `notify`, `stateDir`, `authenticatedUser`, `engineKnows`, `recordReviewSession`,
 *     `breakerTripped`, `alreadyReviewed`, `autoMergeEnabled`) is wired for cron-review.mjs's
 *     contract (see cron-review.test.mjs) — then releases the lock.
 *   - `deps.spawnReviewSession`, when injected, is threaded through unchanged into
 *     `cronReview`'s opts — the composition root never intercepts or wraps it. When OMITTED, the
 *     default is the real production actuator, which refuses an invalid `pr.number === 0` WITHOUT
 *     throwing the legacy "no production wiring yet" stub error.
 *   - The windowed breaker's `now` must be THREADED AS A NUMBER into `./cron-state.mjs` (i.e.
 *     `deps.now()` is invoked, never the function itself passed through) — otherwise the
 *     window-rollover comparison inside cron-state degrades to NaN and the breaker can never
 *     recover once tripped, even long after its window has genuinely elapsed.
 *   - The DEFAULT `crossFamilyEligible` seam is bound to a real synchronous closure that runs the
 *     codex 2nd family via `deps.loadCodexDriver` (async, loaded once at setup, returns
 *     `{ runCodexRole, checkAvailability, securityVerdict, composeRolePrompt }` or `null`). The
 *     closure is invoked `(pr, { changedFiles, sha, stateDir })` — where `stateDir` is already the
 *     REVIEW stateDir (`join(config.stateDir, "review")`) as passed in by cronReview — and it
 *     writes a SIBLING artifact `review-<n>-<sha>.crossfamily.json` next to (never replacing) the
 *     canonical `review-<n>-<sha>.json` written elsewhere by cron-review.mjs.
 *   - `config.autoMergeEnabled` is threaded into `cronReview`'s opts as `autoMergeEnabled` with a
 *     STRICT `=== true` comparison — any other value (omitted, a truthy non-boolean string, etc.)
 *     resolves to `false`.
 *
 * Tests 1 and 4 (and the two rollover/wiring tests below) use the REAL `./run-lock.mjs` and/or
 * `./cron-state.mjs` functions against real temp directories so the lock-separation and the
 * per-session breaker cap/rollover are proven against genuine filesystem state, never an injected
 * already-true shortcut alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCronReview, mainCronReview, makeIssueOpen } from "./run-cron-review.mjs";
import { acquire, release } from "./run-lock.mjs";
import { recordReviewSession, breakerTripped } from "./cron-state.mjs";
import { createRun, updateMeta, readMeta } from "./obs-outbox.mjs";

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

// A fake codex driver injected via deps.loadCodexDriver. runCodexRole records the prompt it receives.
function makeFakeCodexDriver({ adversaryIssues = [], securityIssues = [], available = true } = {}) {
  const runCodexRole = makeSpy(({ role }) => ({
    available,
    output: { issues: role === "security" ? securityIssues : adversaryIssues },
  }));
  const driver = {
    runCodexRole,
    checkAvailability: () => ({ ok: available, reason: "" }),
    securityVerdict: (issues = []) => (issues.some((i) => i.severity === "high" || i.severity === "medium") ? "UNSAFE" : "SECURE"),
    composeRolePrompt: ({ role, taskJson }) => `CODEX ${role} PROMPT ::: ${typeof taskJson === "string" ? taskJson : JSON.stringify(taskJson)}`,
  };
  return { driver, runCodexRole };
}

// A driver whose runCodexRole returns caller-controlled RAW output objects per role (to exercise malformed codex output).
function makeRawCodexDriver({ adversaryOutput, securityOutput, available = true }) {
  const runCodexRole = makeSpy(({ role }) => ({ available, output: role === "security" ? securityOutput : adversaryOutput }));
  return {
    driver: {
      runCodexRole,
      checkAvailability: () => ({ ok: available, reason: "" }),
      securityVerdict: (issues = []) => (issues.some((i) => i.severity === "high" || i.severity === "medium") ? "UNSAFE" : "SECURE"),
      composeRolePrompt: ({ role, taskJson }) => `CODEX ${role} ::: ${typeof taskJson === "string" ? taskJson : JSON.stringify(taskJson)}`,
    },
    runCodexRole,
  };
}

// Runs runCronReview with deps.cronReview captured, returns the captured opts (crossFamilyEligible + autoMergeEnabled).
async function captureCronReviewOpts(configOverrides, depsOverrides) {
  let captured = null;
  await runCronReview(
    { ...BASE_CONFIG, ...configOverrides },
    {
      cronReview: (opts) => { captured = opts; },
      runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
      breakerTripped: () => false,
      recordReviewSession: () => {},
      notify: () => {},
      ...depsOverrides,
    }
  );
  return captured;
}

test("run-cron-review: safeNotify sends every UNROUTABLE event (no resolvable run topic) to the global thread — suppression applies only to successfully-routed lifecycle", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "harness-review-safenotify-"));
  const notifySpy = makeSpy();
  const captured = await captureCronReviewOpts({ stateDir }, { notify: notifySpy });
  const safeNotify = captured.notify;

  safeNotify({ type: "review-started", pr: 1 });
  safeNotify({ type: "pr-merged", pr: 2 });
  safeNotify({ type: "pr-awaiting-merge", pr: 3 });
  safeNotify({ type: "pr-blocked", pr: 4 });
  safeNotify({ type: "failed", pr: 5 });
  safeNotify({ type: "pr-branch-updated-retry", pr: 6 });

  const passedTypes = notifySpy.calls.map(([e]) => e.type);
  assert.ok(passedTypes.includes("review-started"), "an unroutable review-started (no resolvable root/threadId) must still reach the global topic");
  assert.ok(passedTypes.includes("pr-merged"), "an unroutable pr-merged must still reach the global topic");
  assert.ok(passedTypes.includes("pr-awaiting-merge"), "pr-awaiting-merge (actionable) must still reach the global topic");
  assert.ok(passedTypes.includes("pr-blocked"), "error events must still reach the global topic");
  assert.ok(passedTypes.includes("failed"), "error events must still reach the global topic");
  assert.ok(passedTypes.includes("pr-branch-updated-retry"), "an unroutable pr-branch-updated-retry must still reach the global topic — suppression only applies once an event is successfully routed to a run topic");
});

test("mainCronReview: drains the observability outbox each tick (P7) with spacing, sharing Cron A's drain.lock", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "harness-review-drain-"));
  const homeDir = mkdtempSync(join(tmpdir(), "harness-review-home-"));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), "TELEGRAM_BOT_TOKEN=fake\nTELEGRAM_CHAT_ID=999\n", "utf8");

  const config = { project: "demo", stateDir, homeDir, notify: { chatId: 999 } };

  let drainCalls = 0;
  let seenOpts = null;
  await mainCronReview(config, {
    runCronReview: async () => {}, // stub the review — we only assert the drain wiring
    drainOutbox: async (opts) => { drainCalls += 1; seenOpts = opts; },
  });

  assert.strictEqual(drainCalls, 1, "the review cron must drain the outbox exactly once per tick");
  assert.strictEqual(seenOpts.stateDir, stateDir, "the drain targets the run stateDir");
  assert.ok(seenOpts.sendDelayMs > 0, "sends are spaced (same as Cron A)");
  assert.ok(!existsSync(join(stateDir, "drain.lock")), "the drain.lock is released after the drain");
});

// ---------------------------------------------------------------------------
// #235/task-7: mainCronReview wires a real issueOpen seam into its drain, reusing run-reaper.mjs's
// gh-scoped makeDefaultIssueClosed with a finite gh spawn timeout (#ac-1.4).
// ---------------------------------------------------------------------------

/** @description Fake `deps.spawn` seam mirroring spawnSync's shape, resolving a canned
 * `gh issue view --json state` response and recording every call's opts. */
function makeFakeSpawn(ghResponse = { status: 0, stdout: JSON.stringify({ state: "OPEN" }) }) {
  const calls = [];
  const spawn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return ghResponse;
  };
  return { spawn, calls };
}

function homeWithToken(prefix) {
  const homeDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(homeDir, ".claude"), { recursive: true });
  writeFileSync(join(homeDir, ".claude", ".dev.vars"), "TELEGRAM_BOT_TOKEN=fake\nTELEGRAM_CHAT_ID=999\n", "utf8");
  return homeDir;
}

test("#235/task-7 mainCronReview: threads a real issueOpen function into the drainOutbox opts, resolving true for a gh-confirmed OPEN issue", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "harness-review-issueopen-"));
  const homeDir = homeWithToken("harness-review-issueopen-home-");
  const config = { ...BASE_CONFIG, stateDir, homeDir, notify: { chatId: 999 } };
  const { spawn } = makeFakeSpawn({ status: 0, stdout: JSON.stringify({ state: "OPEN" }) });

  let receivedOpts;
  await mainCronReview(config, {
    runCronReview: async () => {},
    drainOutbox: async (opts) => { receivedOpts = opts; },
    spawn,
  });

  assert.strictEqual(typeof receivedOpts.issueOpen, "function", "the drain opts must carry an issueOpen function");
  assert.strictEqual(receivedOpts.issueOpen(42), true, "a gh-confirmed OPEN issue must resolve issueOpen(n) === true");
});

test("#235/task-7 mainCronReview: issueOpen resolves false for a gh-confirmed CLOSED issue (do-not-mint)", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "harness-review-issueopen-"));
  const homeDir = homeWithToken("harness-review-issueopen-home-");
  const config = { ...BASE_CONFIG, stateDir, homeDir, notify: { chatId: 999 } };
  const { spawn } = makeFakeSpawn({ status: 0, stdout: JSON.stringify({ state: "CLOSED" }) });

  let receivedOpts;
  await mainCronReview(config, {
    runCronReview: async () => {},
    drainOutbox: async (opts) => { receivedOpts = opts; },
    spawn,
  });

  assert.strictEqual(receivedOpts.issueOpen(42), false, "a gh-confirmed CLOSED issue must resolve issueOpen(n) === false");
});

test("#235/task-7 mainCronReview: a gh outage (non-zero status) makes issueOpen resolve null (unknown) and mainCronReview never rejects", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), "harness-review-issueopen-"));
  const homeDir = homeWithToken("harness-review-issueopen-home-");
  const config = { ...BASE_CONFIG, stateDir, homeDir, notify: { chatId: 999 } };
  const { spawn } = makeFakeSpawn({ status: 1, stdout: "" });

  let receivedOpts;
  await assert.doesNotReject(
    mainCronReview(config, {
      runCronReview: async () => {},
      drainOutbox: async (opts) => { receivedOpts = opts; },
      spawn,
    }),
  );

  assert.strictEqual(receivedOpts.issueOpen(42), null, "a gh outage must resolve issueOpen(n) === null (unknown) — never authorize a mint AND never authorize a finalize-closed under uncertainty");
});

test("#235/task-7 makeIssueOpen: passes a finite opts.timeout and killSignal:'SIGKILL' to every gh spawn (#ac-1.4)", () => {
  const { spawn, calls } = makeFakeSpawn({ status: 0, stdout: JSON.stringify({ state: "OPEN" }) });

  const issueOpen = makeIssueOpen({ owner: "acme", repo: "demo-repo" }, { spawn });
  issueOpen(42);

  assert.strictEqual(calls.length, 1, "exactly one gh spawn call");
  assert.ok(Number.isFinite(calls[0].opts.timeout) && calls[0].opts.timeout > 0, "the spawn call must carry a finite timeout");
  assert.strictEqual(calls[0].opts.killSignal, "SIGKILL", "the spawn call must carry killSignal:'SIGKILL'");
});

/** @description Creates a fresh temp stateDir for a test, and returns a cleanup callback. */
function withTempStateDir(prefix) {
  const stateDir = mkdtempSync(join(tmpdir(), prefix));
  return { stateDir, cleanup: () => rmSync(stateDir, { recursive: true, force: true }) };
}

test("run-cron-review: acquires a SEPARATE lock under join(stateDir, 'review') — a lock already held on the base stateDir never blocks it", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-lock-");
  try {
    const now = () => 1_000_000;
    const kill = () => {}; // never throws -> "alive"
    const tmuxHasSession = () => false;

    const baseLock = acquire({ stateDir, pid: 111, now, kill, tmuxHasSession });
    assert.ok(baseLock.acquired, "precondition: acquiring the lock on the base stateDir must succeed");

    const cronReviewSpy = makeSpy(() => ({}));

    await runCronReview(
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

test("run-cron-review: kill switch OFF (config.reviewEnabled === false) exits WITHOUT spawning any review session", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-kill-");
  try {
    const cronReviewSpy = makeSpy(() => ({}));

    await runCronReview(
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

test("run-cron-review: circuit-breaker tripped for the window stops spawning AND emits a notification", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-breaker-");
  try {
    const cronReviewSpy = makeSpy(() => ({}));
    const notifySpy = makeSpy();

    await runCronReview(
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

test("run-cron-review: the breaker cap is reached by REAL per-session increments, not an injected already-tripped flag", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-realcap-");
  try {
    const reviewStateDir = join(stateDir, "review");
    const nowTs = 2_000_000;

    // Seed the REAL breaker state with 12 genuinely-recorded sessions this window (the documented
    // BREAKER_MAX_SESSIONS in cron-state.mjs) — driving the cap via real per-session increments,
    // never a fabricated tripped flag. cron-state.mjs's `now` param is NUMERIC (seconds), never a
    // function — seeding it with a function pins the exact bug this suite corrects.
    for (let i = 0; i < 12; i += 1) {
      recordReviewSession({ stateDir: reviewStateDir, now: nowTs });
    }
    assert.ok(
      breakerTripped({ stateDir: reviewStateDir, now: nowTs }),
      "sanity precondition: 12 real recorded sessions this window must trip the real breaker"
    );

    const cronReviewSpy = makeSpy(() => ({}));
    const notifySpy = makeSpy();

    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: cronReviewSpy,
        notify: notifySpy,
        // `now` here is the run-lock-style clock function dep — runCronReview must invoke it and
        // pass the resulting NUMBER into cron-state.breakerTripped, matching how the state above
        // was genuinely seeded with the same numeric instant.
        now: () => nowTs,
        // breakerTripped / recordReviewSession intentionally OMITTED here — they must default to
        // the REAL cron-state functions scoped to join(stateDir, "review"), so the real state
        // seeded above (with a NUMERIC now) is what actually gates this (K+1)th attempt.
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

test("run-cron-review: wires deps.spawnReviewSession through to cronReview's opts without throwing", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-wiring-spawn-");
  try {
    const spawnReviewSessionSpy = makeSpy(() => ({}));
    const cronReviewSpy = makeSpy((opts) => {
      opts.spawnReviewSession({ number: 1, headSha: "abc1234" }, { stateDir: "x", changedFiles: [] });
    });

    await assert.doesNotReject(async () => {
      await runCronReview(
        { ...BASE_CONFIG, stateDir },
        {
          cronReview: cronReviewSpy,
          spawnReviewSession: spawnReviewSessionSpy,
          runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
          breakerTripped: () => false,
          recordReviewSession: () => {},
          notify: () => {},
          now: () => 1_000_000,
        }
      );
    }, "runCronReview must wire the injected spawnReviewSession through to cronReview's opts without throwing");

    assert.equal(
      spawnReviewSessionSpy.calls.length,
      1,
      "the injected deps.spawnReviewSession must be invoked exactly once, via cronReview's opts.spawnReviewSession"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: the default spawnReviewSession refuses an invalid pr.number === 0 WITHOUT throwing the legacy 'no production wiring yet' stub error", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-wiring-invalid-");
  try {
    let capturedOpts;
    const cronReviewSpy = makeSpy((opts) => {
      capturedOpts = opts;
    });

    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: cronReviewSpy,
        // deps.spawnReviewSession intentionally OMITTED — the default must be the real production
        // actuator, not the throwing stub.
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        notify: () => {},
        now: () => 1_000_000,
      }
    );

    assert.ok(capturedOpts, "precondition: cronReview must be called and receive its opts");
    assert.doesNotThrow(
      () => capturedOpts.spawnReviewSession({ number: 0 }, { stateDir: join(stateDir, "review"), changedFiles: [] }),
      "the default (production) spawnReviewSession must reject pr.number === 0 WITHOUT throwing the placeholder 'no production wiring yet' stub error"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: the real breaker recovers once its window genuinely rolls over — now must be threaded as a NUMBER into cron-state, not passed through as a stale function", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-rollover-");
  try {
    const reviewStateDir = join(stateDir, "review");
    const windowStart = 1_000_000;

    // Seed the REAL breaker with 12 sessions at a numeric window_start.
    for (let i = 0; i < 12; i += 1) {
      recordReviewSession({ stateDir: reviewStateDir, now: windowStart });
    }
    assert.ok(
      breakerTripped({ stateDir: reviewStateDir, now: windowStart }),
      "sanity precondition: 12 real recorded sessions at windowStart must trip the real breaker"
    );

    const afterWindow = windowStart + 21_601; // just past the 21600s window
    const cronReviewSpy = makeSpy(() => ({}));
    const notifySpy = makeSpy();

    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: cronReviewSpy,
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        notify: notifySpy,
        now: () => afterWindow,
        // breakerTripped / recordReviewSession intentionally OMITTED — the REAL cron-state
        // functions must receive a NUMERIC now (i.e. runCronReview must invoke now() before
        // handing it to cron-state), so the elapsed window is correctly detected as rolled over
        // and the breaker recovers — instead of jamming on a NaN comparison (now - window_start
        // where `now` is a function, not a number) and never recovering.
      }
    );

    assert.ok(
      cronReviewSpy.calls.length >= 1,
      "once the breaker window has genuinely rolled over, cronReview must run again — a now-threading bug (passing the clock function itself into cron-state instead of invoking it) would leave the window comparison as NaN and the breaker would never recover"
    );
  } finally {
    cleanup();
  }
});

const PR = { number: 70, headRefName: "harness/100", headSha: "deadbeef1", url: "u70" };

test("run-cron-review: crossFamilyEligible closure runs codex, writes crossfamily artifact, resolves true on a CLEAN 2nd family", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-clean-");
  try {
    const { driver } = makeFakeCodexDriver({ adversaryIssues: [], securityIssues: [], available: true });
    const gh = makeSpy((args) => {
      if (args[0] === "pr" && args[1] === "view") return { headRefOid: "deadbeef1" };
      if (args[0] === "pr" && args[1] === "diff") return "diff --git a/x b/x\n+real patch body";
      return { ok: true };
    });
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: ["x"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, true, "CLEAN 2nd family + available => eligible true (stub available:false is gone)");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.equal(artifact.available, true);
    assert.equal(artifact.verdict, "CLEAN");
  } finally {
    cleanup();
  }
});

test("run-cron-review: crossFamilyEligible closure returns a plain boolean (never a Promise) on both the CLEAN and driver-absent paths", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-bool-");
  try {
    const { driver } = makeFakeCodexDriver({ available: true });
    const ghClean = makeSpy((args) => (args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "PATCH TEXT" : { ok: true })));
    const reviewStateDir = join(stateDir, "review");
    const capturedClean = await captureCronReviewOpts({ stateDir }, { gh: ghClean, loadCodexDriver: async () => driver });
    const r1 = capturedClean.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(typeof r1, "boolean");
    assert.ok(!(r1 && typeof r1.then === "function"), "must not be a thenable");
    const capturedAbsent = await captureCronReviewOpts({ stateDir }, { gh: ghClean, loadCodexDriver: async () => null });
    const r2 = capturedAbsent.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(typeof r2, "boolean");
    assert.equal(r2, true, "driver absent => genuine absence => fail-open true (operator accepted this trade-off, no Codex budget)");
  } finally {
    cleanup();
  }
});

test("run-cron-review: the codex runner receives the REAL full-patch text, never {ok:true} nor empty", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-patch-");
  try {
    const { driver, runCodexRole } = makeFakeCodexDriver({ available: true });
    const patch = "diff --git a/f b/f\n@@\n+the real patch content";
    const gh = makeSpy((args) => (args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? patch : { ok: true })));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    captured.crossFamilyEligible(PR, { changedFiles: ["f"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.ok(runCodexRole.calls.length >= 1, "runCodexRole must be called for the eyes");
    const promptArg = runCodexRole.calls[0][0].prompt;
    assert.equal(typeof promptArg, "string");
    assert.ok(promptArg.includes("the real patch content"), "the codex prompt must embed the real patch text");
    assert.ok(!promptArg.includes("[object Object]"), "must not pass a {ok:true} object as the patch");
  } finally {
    cleanup();
  }
});

test("run-cron-review: a headRefOid that drifted from sha runs NO codex eye and resolves true (genuine absence, fail-open — still re-reviewed next cycle at the new sha)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-drift-");
  try {
    const { driver, runCodexRole } = makeFakeCodexDriver({ available: true });
    const gh = makeSpy((args) => (args[1] === "view" ? { headRefOid: "DIFFERENTsha" } : (args[1] === "diff" ? "PATCH" : { ok: true })));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, true, "head drift => no verdict produced => genuine absence => fail-open true");
    assert.equal(runCodexRole.calls.length, 0, "no codex eye may run when the head drifted");
  } finally {
    cleanup();
  }
});

test("run-cron-review: a transient patch-fetch failure ({ok:false,diffFailed:true}) fails CLOSED (false) — infra flakiness is NOT the operator's accepted Codex-absent fail-open", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-difffail-");
  try {
    const { driver, runCodexRole } = makeFakeCodexDriver({ available: true });
    // driver available + head matches, but the FULL-patch fetch (gh pr diff <n>, no --name-only) returns
    // the gh-exec fail-closed sentinel. This must NOT be confused with a genuinely empty diff / absent driver.
    const gh = makeSpy((args) =>
      args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? { ok: false, diffFailed: true } : { ok: true })
    );
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: ["f"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "a diff-fetch failure is infra failure — must stay fail-closed, never hand out a no-second-family auto-merge");
    assert.equal(runCodexRole.calls.length, 0, "no codex eye may run when the patch fetch failed");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.equal(artifact.available, false);
    assert.equal(artifact.diffFailed, true, "the artifact records the infra-failure cause for traceability, distinct from accepted absence");
  } finally {
    cleanup();
  }
});

test("run-cron-review: driver-absent (or checkAvailability not-ok) is genuine absence — resolves true (fail-open), still records available:false, never throws", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-absent-");
  try {
    const gh = makeSpy((args) => (args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "PATCH" : { ok: true })));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => null });
    let result;
    assert.doesNotThrow(() => {
      result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    });
    assert.equal(result, true, "genuine absence must fail-open — the artifact still records available:false for traceability");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.equal(artifact.available, false);
  } finally {
    cleanup();
  }
});

test("run-cron-review: autoMergeEnabled is threaded into cronReview opts with a strict === true default-false", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-flag-");
  try {
    const gh = makeSpy(() => ({ ok: true }));
    const omitted = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => null });
    assert.equal(omitted.autoMergeEnabled, false, "omitted config => false");
    const truthyString = await captureCronReviewOpts({ stateDir, autoMergeEnabled: "true" }, { gh, loadCodexDriver: async () => null });
    assert.equal(truthyString.autoMergeEnabled, false, "a truthy non-true config value must NOT enable auto-merge (strict ===)");
    // runtime:"claude" short-circuits ocAutoMergeGateOpen to true (non-OC no-op path) so this test
    // does not depend on the live, operator-mutable core/opencode/oc-automerge-preconditions.json —
    // a red suite here must never block the whole auto-merge-gated fleet if an operator flips a key.
    const enabled = await captureCronReviewOpts({ stateDir, autoMergeEnabled: true, runtime: "claude" }, { gh, loadCodexDriver: async () => null });
    assert.equal(enabled.autoMergeEnabled, true, "autoMergeEnabled:true threads true");
  } finally {
    cleanup();
  }
});

test("run-cron-review: the cross-family step writes ONLY the crossfamily sibling, never the canonical review-<n>-<sha>.json", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-canon-");
  try {
    const { driver } = makeFakeCodexDriver({ available: true });
    const gh = makeSpy((args) => (args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "PATCH" : { ok: true })));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.ok(existsSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json")), "sibling crossfamily artifact must be written");
    assert.ok(!existsSync(join(reviewStateDir, "review-70-deadbeef1.json")), "the canonical artifact must NOT be written by the cross-family step");
  } finally {
    cleanup();
  }
});

test("run-cron-review: codex adversary output lacking an issues[] array fails CLOSED (not become CLEAN), never coerced to [] -> CLEAN", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-malformed-adv-");
  try {
    const { driver } = makeRawCodexDriver({ adversaryOutput: { note: "no issues key here" }, securityOutput: { verdict: "SECURE", issues: [] }, available: true });
    const gh = makeSpy((args) => args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "REAL PATCH" : { ok: true }));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "a codex output with no issues[] must never resolve to eligible/CLEAN");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.notEqual(artifact.verdict, "CLEAN", "the recorded verdict must not be CLEAN for a malformed codex output");
  } finally { cleanup(); }
});

test("run-cron-review: codex security output with an explicit verdict UNSAFE blocks even if its issues[] is empty", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-unsafe-verdict-");
  try {
    const { driver } = makeRawCodexDriver({ adversaryOutput: { issues: [] }, securityOutput: { verdict: "UNSAFE", issues: [] }, available: true });
    const gh = makeSpy((args) => args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "REAL PATCH" : { ok: true }));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "an explicit codex security verdict UNSAFE must block regardless of an empty issues[]");
  } finally { cleanup(); }
});

test("run-cron-review: codex security verdict 'unsafe' (lowercase) with empty issues still blocks (case-insensitive UNSAFE guard)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-unsafe-lower-");
  try {
    const { driver } = makeRawCodexDriver({ adversaryOutput: { issues: [] }, securityOutput: { verdict: "unsafe", issues: [] }, available: true });
    const gh = makeSpy((args) => args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "REAL PATCH" : { ok: true }));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "a lowercase 'unsafe' verdict must block just like 'UNSAFE'");
  } finally { cleanup(); }
});

test("run-cron-review: codex security verdict 'UNSAFE ' with trailing whitespace still blocks (trimmed UNSAFE guard)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-unsafe-ws-");
  try {
    const { driver } = makeRawCodexDriver({ adversaryOutput: { issues: [] }, securityOutput: { verdict: "UNSAFE ", issues: [] }, available: true });
    const gh = makeSpy((args) => args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "REAL PATCH" : { ok: true }));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "a 'UNSAFE ' verdict with whitespace must block");
  } finally { cleanup(); }
});

test("run-cron-review: the codex eye spawn env is scrubbed of hand-token credentials (no ANTHROPIC_AUTH_TOKEN / OLLAMA_HAND_TOKEN leak to the codex binary)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-envscrub-");
  const prevA = process.env.ANTHROPIC_AUTH_TOKEN;
  const prevO = process.env.OLLAMA_HAND_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "secret-anthropic";
  process.env.OLLAMA_HAND_TOKEN = "secret-ollama";
  try {
    const { driver, runCodexRole } = makeFakeCodexDriver({ available: true });
    const gh = makeSpy((args) => args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "PATCH" : { ok: true }));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.ok(runCodexRole.calls.length >= 1, "runCodexRole must be called");
    const envArg = runCodexRole.calls[0][0].env;
    assert.equal(typeof envArg, "object", "runCodexRole must receive an explicit env (scrubbed), not undefined");
    assert.equal(envArg.ANTHROPIC_AUTH_TOKEN, undefined, "ANTHROPIC_AUTH_TOKEN must be scrubbed from the codex spawn env");
    assert.equal(envArg.OLLAMA_HAND_TOKEN, undefined, "OLLAMA_HAND_TOKEN must be scrubbed from the codex spawn env");
  } finally {
    if (prevA === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevA;
    if (prevO === undefined) delete process.env.OLLAMA_HAND_TOKEN; else process.env.OLLAMA_HAND_TOKEN = prevO;
    cleanup();
  }
});

// A driver whose runCodexRole returns a caller-supplied FULL envelope per role (available + output),
// so a test can model "this eye RAN, that eye rate-limited/hung" independently — the crux of the
// fail-open-on-codex-crash change. checkAvailability is ok (authed) so the eyes are actually attempted.
function makeEyeDriver({ adv, sec }) {
  const runCodexRole = makeSpy(({ role }) => (role === "security" ? sec : adv));
  return {
    driver: {
      runCodexRole,
      checkAvailability: () => ({ ok: true, reason: "" }),
      securityVerdict: (issues = []) => (issues.some((i) => i.severity === "high" || i.severity === "medium") ? "UNSAFE" : "SECURE"),
      composeRolePrompt: ({ role }) => `CODEX ${role} PROMPT`,
    },
    runCodexRole,
  };
}

const ghHeadPatch = makeSpy((args) => (args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "REAL PATCH" : { ok: true })));

test("run-cron-review: BOTH codex eyes failed to run (available:false, rate-limit) and none flagged → GENUINE ABSENCE → fail-open true (operator's Codex-budget case)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-both-ratelimited-");
  try {
    const { driver } = makeEyeDriver({
      adv: { available: false, reason: "codex run failed: rate limit" },
      sec: { available: false, reason: "codex run failed: rate limit" },
    });
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh: ghHeadPatch, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: ["f"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, true, "a Codex that can't run (rate-limit) must NOT hold auto-merge hostage — genuine absence fails OPEN");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.equal(artifact.available, false, "absence records available:false");
    assert.equal(artifact.verdict, null, "absence writes verdict:null DIRECT (never the derived BLOCKED) so fail-open is reachable");
  } finally { cleanup(); }
});

test("run-cron-review: adversary ran clean but security failed to run (rate-limit) → not a full clean, nothing flagged → fail-open true", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-partial-ran-");
  try {
    const { driver } = makeEyeDriver({
      adv: { available: true, output: { issues: [] } },
      sec: { available: false, reason: "codex run failed: timeout" },
    });
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh: ghHeadPatch, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: ["f"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, true, "one eye clean + one eye that never ran (and no flag) is a genuine absence → fail-open");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.equal(artifact.verdict, null, "the partial-run absence writes verdict:null");
  } finally { cleanup(); }
});

test("run-cron-review: a codex eye that RAN and returned UNSAFE (available:true) BLOCKS — a real finding is NEVER swallowed by the fail-open (safety regression guard)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-ran-unsafe-");
  try {
    const { driver } = makeEyeDriver({
      adv: { available: true, output: { verdict: "UNSAFE", issues: [] } },
      sec: { available: false, reason: "codex run failed: rate limit" }, // even with the OTHER eye down
    });
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh: ghHeadPatch, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: ["f"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "a real UNSAFE (available:true) must BLOCK — the fail-open must never swallow a genuine finding");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.notEqual(artifact.verdict, null, "a flagged eye writes the derived (BLOCKED) verdict, NOT the verdict:null absence");
  } finally { cleanup(); }
});

test("run-cron-review: an eye that RAN with verdict SECURE but a HIGH issue (securityVerdict→UNSAFE) BLOCKS — the dangerous collapse cannot fail-open", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-ran-high-issue-");
  try {
    const { driver } = makeEyeDriver({
      adv: { available: true, output: { verdict: "SECURE", issues: [{ severity: "high", scope: "core/x.mjs", evidence: "e" }] } },
      sec: { available: true, output: { issues: [] } },
    });
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh: ghHeadPatch, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: ["f"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "a SECURE verdict hiding a HIGH issue is NOT clean — adversaryClean=false → block, never fail-open");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.notEqual(artifact.verdict, null, "a flagged (HIGH-issue) eye must not take the verdict:null absence path");
  } finally { cleanup(); }
});

test("run-cron-review: BOTH eyes ran fully clean → real cross-family CLEAN → eligible true, artifact verdict CLEAN", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-both-clean-");
  try {
    const { driver } = makeEyeDriver({
      adv: { available: true, output: { issues: [] } },
      sec: { available: true, output: { verdict: "SECURE", issues: [] } },
    });
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh: ghHeadPatch, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: ["f"], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, true, "both eyes fully clean is a real CLEAN — eligible");
    const artifact = JSON.parse(readFileSync(join(reviewStateDir, "review-70-deadbeef1.crossfamily.json"), "utf8"));
    assert.equal(artifact.available, true, "a full clean records available:true");
    assert.equal(artifact.verdict, "CLEAN", "a full clean records the derived CLEAN verdict");
  } finally { cleanup(); }
});

test("run-cron-review: the DEFAULT reconcile closure releases chained dependents whose dependencies have merged (queued->ready + chain-released notify)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-chain-");
  try {
    // gh fake: reconcile's non-terminal label scans return [] (nothing to self-heal); the queued
    // scan returns one dependent whose single dependency (#12) has a merged PR.
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args[0] === "issue" && args[1] === "list") {
        const li = args.indexOf("--label");
        const label = li !== -1 ? args[li + 1] : "";
        return label === "harness:queued" ? [{ number: 50, body: "```harness-deps\n#12\n```" }] : [];
      }
      if (args[0] === "pr" && args[1] === "list") {
        if (args.includes("--head")) {
          const head = args[args.indexOf("--head") + 1];
          return String(head) === "harness/12" ? [{ number: 999 }] : [];
        }
        return []; // open-PR list (cronReview is captured, never calls this)
      }
      if (args[0] === "issue" && args[1] === "view") return { labels: [] };
      return { ok: true };
    };

    const notify = makeSpy();
    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        gh,
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify,
      }
    );

    // The composition root did NOT inject reconcile, so captured.reconcile is the DEFAULT closure
    // that runs review-merge.reconcile() AND releaseChainedDependents().
    assert.equal(typeof captured.reconcile, "function", "cronReview must receive a reconcile closure");
    captured.reconcile();

    const releasedEdit = calls.find(
      (a) => a[0] === "issue" && a[1] === "edit" && a[2] === "50" && a.includes("--add-label") && a.includes("harness:ready") && a.includes("--remove-label") && a.includes("harness:queued")
    );
    assert.ok(releasedEdit, "the default reconcile closure must relabel the satisfied dependent queued->ready");
    assert.ok(
      notify.calls.some((a) => a[0] && a[0].type === "chain-released" && a[0].issue === 50),
      "a chain-released notification must fire (carrying the project via safeNotify)"
    );
    assert.ok(
      notify.calls.some((a) => a[0] && a[0].project === "demo"),
      "safeNotify must inject the project slug into chaining events"
    );
  } finally {
    cleanup();
  }
});

// --- F2: routeReject's bound `reviewed` object must actually expose recordReviewed ---
// The composition root binds `reviewed = { alreadyReviewed }` (today) at the routeReject closure's
// definition site, and routeReject.mjs unconditionally calls `reviewed.recordReviewed(pr.number,
// sha)` on BOTH its ceiling and re-queue branches. These two tests deliberately drive the REAL
// default `routeRejectFn` (deps.routeReject is NEVER overridden below) so a broken real binding is
// caught here instead of being masked by a fake-injected routeReject. They are pinned RED against
// the contract until a separate production change adds `recordReviewed` to the bound `reviewed`
// object.

test("run-cron-review: routeReject's REAL binding persists the reviewed pr:sha key to cron-reviewed.json via reviewed.recordReviewed (F2)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-routereject-real-");
  try {
    const reviewStateDir = join(stateDir, "review");
    // Fresh stateDir => the real chain depth for root 42 is 0 (below the ceiling of 3), so
    // routeReject takes the re-queue branch (not the atCeiling branch) — no extra chain seeding
    // is needed to stay below ceiling.
    const gh = makeSpy(() => ({ ok: true }));

    const captured = await captureCronReviewOpts({ stateDir }, { gh });

    captured.routeReject(
      { number: 501, headRefName: "harness/42" },
      "deadbeef",
      { gh, stateDir: reviewStateDir, findings: { status: "BLOCKED" } }
    );

    const reviewedRecord = JSON.parse(readFileSync(join(reviewStateDir, "cron-reviewed.json"), "utf8"));
    assert.equal(
      reviewedRecord["501:deadbeef"],
      true,
      "the REAL reviewed.recordReviewed binding (invoked from inside routeReject.mjs) must have written the 501:deadbeef key to cron-reviewed.json"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: the captured opts.routeReject is a function whose bound reviewed object exposes a callable recordReviewed (no TypeError)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-routereject-nothrow-");
  try {
    const reviewStateDir = join(stateDir, "review");
    const gh = makeSpy(() => ({ ok: true }));

    const captured = await captureCronReviewOpts({ stateDir }, { gh });

    assert.equal(typeof captured.routeReject, "function", "cronReview must receive a routeReject closure");

    assert.doesNotThrow(
      () => {
        captured.routeReject(
          { number: 501, headRefName: "harness/42" },
          "deadbeef",
          { gh, stateDir: reviewStateDir, findings: { status: "BLOCKED" } }
        );
      },
      "invoking the real routeReject must not throw a TypeError about reviewed.recordReviewed being undefined — the bound reviewed object must expose a callable recordReviewed"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: opts.stalledNotified/recordStalledNotified are bound to the REAL cron-state — recordStalledNotified persists cron-review-stalled-notified.json and stalledNotified subsequently returns true", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-stallednotified-");
  try {
    const reviewStateDir = join(stateDir, "review");
    // deps.stalledNotified / deps.recordStalledNotified intentionally OMITTED — they must default
    // to the REAL cron-state functions scoped to join(stateDir, "review"), mirroring the
    // alreadyReviewed/recordReviewed pair, so this test proves the real binding (never a stub).
    const captured = await captureCronReviewOpts({ stateDir }, {});

    captured.recordStalledNotified(9, "ff01");
    const result = captured.stalledNotified(9, "ff01");

    assert.equal(
      result,
      true,
      "opts.stalledNotified(9,'ff01') must return true after opts.recordStalledNotified(9,'ff01') wrote the REAL cron-state — proving the real binding, not a stub"
    );

    const filePath = join(reviewStateDir, "cron-review-stalled-notified.json");
    assert.ok(existsSync(filePath), "recordStalledNotified must persist cron-review-stalled-notified.json under the review stateDir");
    const record = JSON.parse(readFileSync(filePath, "utf8"));
    assert.equal(typeof record, "object");
    assert.equal(record["9:ff01"], true, "the persisted record must key on `${pr}:${sha}`, exactly like the alreadyReviewed/recordReviewed pair");
  } finally {
    cleanup();
  }
});

// --- H1/H2: safeNotify resolves a run's own Telegram thread via a base-stateDir obs-reader seam
// (`deps.resolveRunThreadId`), and a global-suppression rule keeps ONLY successfully-routed
// normal-lifecycle events (review-started, pr-awaiting-merge, pr-merged, pr-branch-updated-retry)
// out of the shared global topic — every actionable/error event still always reaches global, and an
// unresolved/erroring root falls back to global rather than dropping the event. The fake cronReview
// below emits events by calling `opts.notify` (mirroring production cronReview's real call sites),
// so these tests exercise safeNotify's real routing/suppression logic end to end, never a shortcut
// that hand-builds the final notify payload. Several of these are RED until the production change
// lands — expected.

/**
 * @description Runs runCronReview with a fake cronReview that emits `events` via `opts.notify`, and
 * returns the raw `notify` spy capturing exactly what safeNotify forwards (or withholds).
 */
async function runReviewAndCaptureNotify(configOverrides, depsOverrides, events) {
  const notifySpy = makeSpy();
  await runCronReview(
    { ...BASE_CONFIG, ...configOverrides },
    {
      cronReview: (opts) => {
        for (const event of events) opts.notify(event);
      },
      runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
      breakerTripped: () => false,
      recordReviewSession: () => {},
      notify: notifySpy,
      ...depsOverrides,
    }
  );
  return notifySpy;
}

test("run-cron-review: an injected base-stateDir obs-reader resolves root 42 -> threadId 900, routing pr-awaiting-merge to the run's own thread", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-injected-");
  try {
    const resolveRunThreadId = makeSpy((rootIssue) => (rootIssue === 42 ? 900 : null));
    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      { resolveRunThreadId },
      [{ type: "pr-awaiting-merge", pr: 7, headRefName: "harness/42" }]
    );

    const routed = notifySpy.calls.find(([event]) => event.type === "pr-awaiting-merge");
    assert.ok(routed, "the pr-awaiting-merge event must still reach notify");
    assert.equal(routed[0].threadId, 900, "the event must carry the resolved run threadId, routing it to the run topic");
  } finally {
    cleanup();
  }
});

test("run-cron-review: the DEFAULT obs-reader (no injected resolveRunThreadId) resolves threadId from a REAL obs-<root>.json under the BASE config.stateDir, never reviewStateDir (H1 regression pin)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-default-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900 });
    assert.ok(!existsSync(join(stateDir, "review")), "precondition: join(stateDir,'review') must stay empty — the default reader must never look there");

    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      {},
      [{ type: "pr-awaiting-merge", pr: 7, headRefName: "harness/42" }]
    );

    const routed = notifySpy.calls.find(([event]) => event.type === "pr-awaiting-merge");
    assert.ok(routed, "the pr-awaiting-merge event must still reach notify");
    assert.equal(routed[0].threadId, 900, "the DEFAULT reader must resolve the real obs-42.json seeded under the BASE config.stateDir, never reviewStateDir");
  } finally {
    cleanup();
  }
});

test("run-cron-review: an injected obs-reader that resolves null (root unresolved) still delivers pr-awaiting-merge to the global thread — never dropped (H2 fallback)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-unresolved-");
  try {
    const resolveRunThreadId = makeSpy(() => null);
    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      { resolveRunThreadId },
      [{ type: "pr-awaiting-merge", pr: 7, headRefName: "harness/42" }]
    );

    const fallback = notifySpy.calls.find(([event]) => event.type === "pr-awaiting-merge");
    assert.ok(fallback, "an unresolved root must never cause the event to be dropped");
    assert.ok(!fallback[0].threadId, "with the root unresolved, the event stays on the global thread (no threadId set)");
  } finally {
    cleanup();
  }
});

test("run-cron-review: a resolved pr-merged is routed to the run thread and stays OUT of the global thread once routed", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-prmerged-");
  try {
    const resolveRunThreadId = (rootIssue) => (rootIssue === 42 ? 900 : null);
    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      { resolveRunThreadId },
      [{ type: "pr-merged", pr: 7, headRefName: "harness/42" }]
    );

    const prMergedCalls = notifySpy.calls.filter(([event]) => event.type === "pr-merged");
    assert.ok(prMergedCalls.length >= 1, "the routed pr-merged event must still reach notify");
    assert.ok(prMergedCalls.every(([event]) => event.threadId === 900), "every pr-merged call must carry the resolved run threadId");
    assert.ok(
      !prMergedCalls.some(([event]) => !event.threadId),
      "no pr-merged event may reach notify lacking a threadId — normal lifecycle stays out of the global thread once routed"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: pr-blocked (error event) always reaches the global thread, even when the root resolves a run threadId", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-blocked-");
  try {
    const resolveRunThreadId = (rootIssue) => (rootIssue === 42 ? 900 : null);
    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      { resolveRunThreadId },
      [{ type: "pr-blocked", pr: 7, headRefName: "harness/42" }]
    );

    const blocked = notifySpy.calls.find(([event]) => event.type === "pr-blocked");
    assert.ok(blocked, "pr-blocked must still reach notify");
    assert.ok(!blocked[0].threadId, "error events are never routed away from the global thread");
  } finally {
    cleanup();
  }
});

test("run-cron-review: pr-diff-fetch-failed (actionable/error event) always reaches the global thread — not suppressed", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-difffail-");
  try {
    const resolveRunThreadId = (rootIssue) => (rootIssue === 42 ? 900 : null);
    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      { resolveRunThreadId },
      [{ type: "pr-diff-fetch-failed", pr: 7, headRefName: "harness/42" }]
    );

    const diffFailed = notifySpy.calls.find(([event]) => event.type === "pr-diff-fetch-failed");
    assert.ok(diffFailed, "pr-diff-fetch-failed must still reach notify");
    assert.ok(!diffFailed[0].threadId, "an actionable/error event stays on the global thread even when the root resolves");
  } finally {
    cleanup();
  }
});

test("run-cron-review: pr-review-infra-blocked (actionable/error event) always reaches the global thread — explicit keep-in-global rule", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-infrablocked-");
  try {
    const resolveRunThreadId = (rootIssue) => (rootIssue === 42 ? 900 : null);
    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      { resolveRunThreadId },
      [{ type: "pr-review-infra-blocked", pr: 7, headRefName: "harness/42" }]
    );

    const infraBlocked = notifySpy.calls.find(([event]) => event.type === "pr-review-infra-blocked");
    assert.ok(infraBlocked, "pr-review-infra-blocked must still reach notify");
    assert.ok(!infraBlocked[0].threadId, "a second actionable/error event type stays on the global thread even when the root resolves");
  } finally {
    cleanup();
  }
});

test("run-cron-review: safeNotify resolves the run thread via event.root when already enriched, never by re-extracting from a non-matchable headRefName", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-eventroot-");
  try {
    const resolveRunThreadId = makeSpy((rootIssue) => (rootIssue === 42 ? 900 : null));
    const notifySpy = await runReviewAndCaptureNotify(
      { stateDir },
      { resolveRunThreadId },
      [{ type: "pr-awaiting-merge", pr: 7, root: 42, headRefName: "feat/x" }]
    );

    const routed = notifySpy.calls.find(([event]) => event.type === "pr-awaiting-merge");
    assert.ok(routed, "the pr-awaiting-merge event must still reach notify");
    assert.equal(routed[0].threadId, 900, "safeNotify must resolve via the already-enriched event.root, not by re-parsing the non-matchable headRefName 'feat/x'");
    assert.ok(
      resolveRunThreadId.calls.some(([rootArg]) => rootArg === 42),
      "the obs-reader must be invoked with event.root (42), never a value derived from 'feat/x'"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: safeNotify fails open when the injected obs-reader THROWS while resolving — the event still reaches the global thread and safeNotify never throws", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-threadroute-throws-");
  try {
    const resolveRunThreadId = () => {
      throw new Error("obs-reader boom");
    };

    let notifySpy;
    await assert.doesNotReject(async () => {
      notifySpy = await runReviewAndCaptureNotify(
        { stateDir },
        { resolveRunThreadId },
        [{ type: "pr-awaiting-merge", pr: 7, headRefName: "harness/42" }]
      );
    }, "a throwing obs-reader must never propagate out of safeNotify / runCronReview");

    const delivered = notifySpy.calls.find(([event]) => event.type === "pr-awaiting-merge");
    assert.ok(delivered, "the event must still be delivered even though resolution threw");
    assert.ok(!delivered[0].threadId, "on a throwing resolver, the event fails open to the global thread (no threadId)");
  } finally {
    cleanup();
  }
});

// --- Close-on-merge (#ac-1.4/#ac-1.7): once an issue is detected merged — either via the
// per-cycle reconcile closure (the manual/shipped-default merge path, autoMerge OFF) or via the
// auto-merge path's mergeAndFinalize — run-cron-review reads the issue's BASE obs meta and, if its
// status is not already 'closed', AWAITS `deps.closeForumTopic({threadId}, opts)`. Only when the
// close resolves `{ok:true}` does it mark the meta `{status:'closed', closedAt:<epoch>}` — on
// `{ok:false}` (or a throw) the meta STAYS 'awaiting-review' so a later reaper can re-close a
// merged PR's topic instead of lying 'closed' on a transient send failure (no permanent orphan).
// The close is driven from the per-cycle reconcile closure (called unconditionally at the end of
// every cronReview cycle, on BOTH the manual and auto-merge paths) — NOT from inside the
// mergeAndFinalizeFn closure itself. These tests are RED until the close-on-merge production
// change lands — expected.

test("run-cron-review: close-on-merge (manual/reconcile default path) — closes the forum topic and marks obs meta closed with a numeric closedAt (#ac-1.4)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-manual-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async (arg) => ({ ok: true }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    assert.equal(typeof captured.reconcile, "function", "cronReview must receive a reconcile closure");
    await captured.reconcile();

    assert.ok(
      closeForumTopicSpy.calls.some(([arg]) => arg && arg.threadId === 900),
      "closeForumTopic must be called with {threadId:900} for the merged issue 42 detected by reconcile"
    );

    const meta = readMeta(metaPath);
    assert.equal(meta.status, "closed", "the BASE obs meta must transition to status 'closed'");
    assert.equal(typeof meta.closedAt, "number", "the BASE obs meta must record a NUMERIC closedAt");
  } finally {
    cleanup();
  }
});

test("run-cron-review: close-on-merge ORDERING G1 (auto-merge path) — notify({type:'pr-merged', threadId:900}) fires BEFORE closeForumTopic({threadId:900})", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-order-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const order = [];
    const notifySpy = makeSpy((event) => {
      if (event && event.type === "pr-merged") order.push({ what: "notify-pr-merged", threadId: event.threadId });
    });
    const closeForumTopicFake = makeSpy(async (arg) => {
      order.push({ what: "close", threadId: arg && arg.threadId });
      return { ok: true };
    });

    const pr = { number: 70, headRefName: "harness/42", headRefOid: "deadbeef1", author: { login: "harness" }, labels: [], url: "u70", body: "" };
    const gh = (args) => {
      if (args[0] === "pr" && args[1] === "list") return [pr];
      if (args[0] === "pr" && args[1] === "diff") return ["file.js"];
      return { ok: true };
    };

    await runCronReview(
      { ...BASE_CONFIG, stateDir, autoMergeEnabled: true },
      {
        gh,
        isReviewEligible: () => true,
        getFreshVerdict: () => ({ status: "CLEAN" }),
        crossFamilyEligible: () => true,
        mergeAndFinalize: () => ({ merged: true }),
        reconcile: () => [{ issue: 42, from: "harness:in-review" }],
        closeForumTopic: closeForumTopicFake,
        spawnReviewSession: () => {},
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: notifySpy,
      }
    );

    const notifyIndex = order.findIndex((e) => e.what === "notify-pr-merged");
    const closeIndex = order.findIndex((e) => e.what === "close" && e.threadId === 900);
    assert.ok(notifyIndex !== -1, "the pr-merged notify must be recorded in the shared order log");
    assert.equal(order[notifyIndex].threadId, 900, "the routed pr-merged notify must carry threadId 900 (the run's own forum topic)");
    assert.ok(closeIndex !== -1, "the closeForumTopic call for threadId 900 must be recorded in the shared order log");
    assert.ok(notifyIndex < closeIndex, "notify({type:'pr-merged', threadId:900}) must occur BEFORE closeForumTopic({threadId:900})");
  } finally {
    cleanup();
  }
});

test("run-cron-review: close-on-merge is NOT wired inside the mergeAndFinalizeFn closure — closeForumTopic has not fired the instant mergeAndFinalize returns {merged:true} (auto-merge path)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-notinmerge-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const order = [];
    const closeForumTopicFake = makeSpy((arg) => {
      order.push({ what: "close", threadId: arg && arg.threadId });
    });

    let closeCalledAtMergeReturn = null;

    const pr = { number: 70, headRefName: "harness/42", headRefOid: "deadbeef1", author: { login: "harness" }, labels: [], url: "u70", body: "" };
    const gh = (args) => {
      if (args[0] === "pr" && args[1] === "list") return [pr];
      if (args[0] === "pr" && args[1] === "diff") return ["file.js"];
      return { ok: true };
    };

    const mergeAndFinalizeFake = () => {
      const result = { merged: true };
      closeCalledAtMergeReturn = order.some((e) => e.what === "close" && e.threadId === 900);
      return result;
    };

    await runCronReview(
      { ...BASE_CONFIG, stateDir, autoMergeEnabled: true },
      {
        gh,
        isReviewEligible: () => true,
        getFreshVerdict: () => ({ status: "CLEAN" }),
        crossFamilyEligible: () => true,
        mergeAndFinalize: mergeAndFinalizeFake,
        reconcile: () => [{ issue: 42, from: "harness:in-review" }],
        closeForumTopic: closeForumTopicFake,
        spawnReviewSession: () => {},
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    assert.equal(
      closeCalledAtMergeReturn,
      false,
      "closeForumTopic must NOT have been called at the instant mergeAndFinalize returns {merged:true} — the close-on-merge is wired outside the mergeAndFinalizeFn closure (e.g. the per-cycle reconcile), not inside it"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: close-on-merge is idempotent — an obs meta already status 'closed' is never re-closed (closeForumTopic keyed on status !== 'closed')", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-idempotent-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "closed" });

    const closeForumTopicSpy = makeSpy();
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    await captured.reconcile();

    assert.equal(
      closeForumTopicSpy.calls.length,
      0,
      "closeForumTopic must NOT be called when the merged issue's obs meta is already status 'closed'"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: close-on-merge fails open — a throwing closeForumTopic never breaks the reconcile closure, which still returns its healed list (#ac-1.7)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-failopen-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicThrows = () => {
      throw new Error("forum boom");
    };
    const healedList = [{ issue: 42, from: "harness:awaiting-merge" }];
    const reconcileFake = () => healedList;

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicThrows,
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    let result;
    await assert.doesNotReject(async () => {
      result = await captured.reconcile();
    }, "a throwing closeForumTopic must never propagate out of the reconcile closure");

    assert.deepEqual(
      result,
      healedList,
      "the reconcile closure must still return its healed list even when closeForumTopic throws for a merged issue"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: close-on-merge passes the token-carrying notifier config to closeForumTopic (not the token-less project config)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-notifyconfig-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async (input, opts) => ({ ok: true }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        notifyConfig: { token: "BOT-TOKEN-XYZ", chatId: -100987 },
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    assert.equal(typeof captured.reconcile, "function", "cronReview must receive a reconcile closure");
    await captured.reconcile();

    assert.equal(
      closeForumTopicSpy.calls.length,
      1,
      "closeForumTopic must be called exactly once for the merged issue 42 detected by reconcile"
    );
    const [, opts] = closeForumTopicSpy.calls[0];
    assert.ok(
      opts && opts.config,
      "closeForumTopic must be invoked with a SECOND argument (opts) carrying a config object — closeForumTopic(input, opts)"
    );
    assert.equal(
      opts.config.token,
      "BOT-TOKEN-XYZ",
      "the SECOND argument (opts) reaching closeForumTopic must carry the RESOLVED notifier config (with the token from deps.notifyConfig) — not a token-less project config"
    );
  } finally {
    cleanup();
  }
});

test("run-cron-review: close-on-merge does NOT mark the meta 'closed' when closeForumTopic fails (ok:false) — meta stays 'awaiting-review' so a later sweep can re-close (no permanent orphan)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-okfalse-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async (arg) => ({ ok: false }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        notifyConfig: { token: "BOT-TOKEN-XYZ", chatId: -100987 },
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    assert.equal(typeof captured.reconcile, "function", "cronReview must receive a reconcile closure");
    await captured.reconcile();

    assert.ok(
      closeForumTopicSpy.calls.some(([arg]) => arg && arg.threadId === 900),
      "closeForumTopic must still be called with {threadId:900} for the merged issue 42 detected by reconcile"
    );

    const meta = readMeta(metaPath);
    assert.equal(
      meta.status,
      "awaiting-review",
      "the BASE obs meta must STAY 'awaiting-review' when the close send fails (ok:false) — no permanent orphan lying 'closed'"
    );
    assert.ok(
      meta.closedAt === undefined,
      "closedAt must be absent when the close send failed"
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// #235/task-8: close-on-merge finalizes 'closed' on a permanent thread-not-found (the topic is
// already gone — this run's PR just merged, arguably the MOST likely trigger for the reported
// recurrence), and preserves today's leave-as-is behavior for a genuinely transient failure.
// ---------------------------------------------------------------------------

test("#235/task-8 run-cron-review: close-on-merge finalizes status:'closed' with a numeric closedAt when closeForumTopic resolves {ok:false, reason:'thread-not-found'}", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-tnf-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async () => ({ ok: false, reason: "thread-not-found" }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        notifyConfig: { token: "BOT-TOKEN-XYZ", chatId: -100987 },
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    await captured.reconcile();

    const meta = readMeta(metaPath);
    assert.equal(meta.status, "closed", "a thread-not-found close must still finalize status:'closed' — the topic is already gone, there is nothing to retry");
    assert.equal(typeof meta.closedAt, "number", "closedAt must be a numeric epoch-seconds value");
    assert.equal(meta.topicConfirmedGone, true, "a thread-not-found close-on-merge must flag topicConfirmedGone identically to notify-telegram.mjs's self-heal finalize, so drainTelegramOutbox's isFallback routes any remaining cosmetic event to the shared topic instead of retrying this dead threadId forever");
  } finally {
    cleanup();
  }
});

test("#235/final-review run-cron-review: close-on-merge does NOT flag topicConfirmedGone on a normal successful close (ok:true) — the topic is merely archived, not confirmed gone, and must keep targeting its own thread", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-oktrue-nogone-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async () => ({ ok: true }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        notifyConfig: { token: "BOT-TOKEN-XYZ", chatId: -100987 },
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    await captured.reconcile();

    const meta = readMeta(metaPath);
    assert.equal(meta.status, "closed");
    assert.ok(!meta.topicConfirmedGone, "an ok:true close must NOT flag topicConfirmedGone — the topic still exists (merely archived), so it must keep targeting its own thread, not the shared fallback");
  } finally {
    cleanup();
  }
});

test("#235/task-8 run-cron-review: close-on-merge does NOT finalize 'closed' when closeForumTopic resolves {ok:false, reason:'transient'} (today's leave-as-is preserved)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-transient-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async () => ({ ok: false, reason: "transient" }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        notifyConfig: { token: "BOT-TOKEN-XYZ", chatId: -100987 },
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    await captured.reconcile();

    const meta = readMeta(metaPath);
    assert.equal(meta.status, "awaiting-review", "a transient close failure must NEVER finalize status:'closed' — a later reconcile/reaper retry must still be possible");
  } finally {
    cleanup();
  }
});

test("#235/task-8 run-cron-review: close-on-merge STILL finalizes 'closed' when closeForumTopic resolves {ok:true} (existing success path preserved, no regression)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-oktrue-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async () => ({ ok: true }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        notifyConfig: { token: "BOT-TOKEN-XYZ", chatId: -100987 },
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
      }
    );

    await captured.reconcile();

    const meta = readMeta(metaPath);
    assert.equal(meta.status, "closed", "an ok:true close must still finalize status:'closed' — no regression");
    assert.equal(typeof meta.closedAt, "number");
  } finally {
    cleanup();
  }
});

test("#235/final-review run-cron-review: close-on-merge stamps closedAt from the injected deps.now() seam (determinism — matches cron-a-exit.mjs/reaper.mjs's convention, not a raw Date.now() read)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-review-close-nowseam-");
  try {
    const metaPath = createRun({ issueNumber: 42, project: "demo", worktreePath: "/srv/worktrees/42" }, stateDir);
    updateMeta(metaPath, { threadId: 900, status: "awaiting-review" });

    const closeForumTopicSpy = makeSpy(async () => ({ ok: true }));
    const reconcileFake = () => [{ issue: 42, from: "harness:awaiting-merge" }];

    let captured = null;
    await runCronReview(
      { ...BASE_CONFIG, stateDir },
      {
        cronReview: (opts) => { captured = opts; },
        reconcile: reconcileFake,
        closeForumTopic: closeForumTopicSpy,
        notifyConfig: { token: "BOT-TOKEN-XYZ", chatId: -100987 },
        runLock: { acquire: () => ({ acquired: true, acquireTs: 1 }), release: () => {} },
        breakerTripped: () => false,
        recordReviewSession: () => {},
        loadCodexDriver: async () => null,
        notify: () => {},
        now: () => 1700000000,
      }
    );

    await captured.reconcile();

    const meta = readMeta(metaPath);
    assert.equal(meta.closedAt, 1700000000, "closedAt must equal the injected deps.now() value, not a raw Date.now() read");
  } finally {
    cleanup();
  }
});
