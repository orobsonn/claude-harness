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
 *     `reconcile`, `routeReject`, `touchesGateMachinery`, `mergeEligible`, `spawnReviewSession`,
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
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
    assert.equal(r2, false, "driver absent => fail-open false");
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

test("run-cron-review: a headRefOid that drifted from sha runs NO codex eye and resolves false (re-queue)", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-drift-");
  try {
    const { driver, runCodexRole } = makeFakeCodexDriver({ available: true });
    const gh = makeSpy((args) => (args[1] === "view" ? { headRefOid: "DIFFERENTsha" } : (args[1] === "diff" ? "PATCH" : { ok: true })));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => driver });
    const result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    assert.equal(result, false, "head drift => not eligible");
    assert.equal(runCodexRole.calls.length, 0, "no codex eye may run when the head drifted");
  } finally {
    cleanup();
  }
});

test("run-cron-review: driver-absent (or checkAvailability not-ok) fails open to false and records available:false, never throws", async () => {
  const { stateDir, cleanup } = withTempStateDir("harness-xfam-absent-");
  try {
    const gh = makeSpy((args) => (args[1] === "view" ? { headRefOid: "deadbeef1" } : (args[1] === "diff" ? "PATCH" : { ok: true })));
    const reviewStateDir = join(stateDir, "review");
    const captured = await captureCronReviewOpts({ stateDir }, { gh, loadCodexDriver: async () => null });
    let result;
    assert.doesNotThrow(() => {
      result = captured.crossFamilyEligible(PR, { changedFiles: [], sha: "deadbeef1", stateDir: reviewStateDir });
    });
    assert.equal(result, false);
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
    const enabled = await captureCronReviewOpts({ stateDir, autoMergeEnabled: true }, { gh, loadCodexDriver: async () => null });
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
