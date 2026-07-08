/**
 * @description Contract tests for cron-state.mjs — per-issue attempt counters and the
 * reviewed-SHA marker used by the VPS cron harness. Each test uses a fresh temp state dir
 * (mkdtemp under os.tmpdir()) and removes it afterward; no real `~/.harness-cron` is touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  increment,
  reset,
  read,
  recordReviewed,
  alreadyReviewed,
  incrementChain,
  readChain,
  resetChain,
  atCeiling,
  recordReviewSession,
  breakerTripped,
  incrementUpdateAttempt,
  readUpdateAttempts,
  resetUpdateAttempts,
  incrementInfraFailure,
  readInfraFailure,
  atInfraFailureCeiling,
} from "./cron-state.mjs";

/** @description Makes a fresh temp dir for one test and returns a cleanup callback. */
function makeStateDir() {
  const dir = mkdtempSync(join(tmpdir(), "cron-state-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cron-state counter: increments per issue and resets to 0", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };

    increment(42, opts);
    assert.equal(read(42, opts), 1, "first increment for a fresh issue must read back 1");

    increment(42, opts);
    assert.equal(read(42, opts), 2, "second increment must read back 2");

    reset(42, opts);
    assert.equal(read(42, opts), 0, "reset must bring the counter back to 0");
  } finally {
    cleanup();
  }
});

test("cron-state reviewed-SHA marker: recorded head SHA is remembered per PR, other SHAs are not", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };

    recordReviewed(7, "abc", opts);

    assert.equal(alreadyReviewed(7, "abc", opts), true, "the exact recorded (pr, sha) pair must read back as reviewed");
    assert.equal(alreadyReviewed(7, "def", opts), false, "a different sha for the same PR must not be reviewed");
  } finally {
    cleanup();
  }
});

test("cron-state update-attempt counter: increments per PR, resets to 0, keyed independently from the attempt/chain counters", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };

    assert.equal(readUpdateAttempts(21, opts), 0, "a fresh PR must read back 0 update-attempts");

    incrementUpdateAttempt(21, opts);
    incrementUpdateAttempt(21, opts);
    assert.equal(readUpdateAttempts(21, opts), 2, "two update-attempt increments for the same PR must read back 2");
    assert.equal(readUpdateAttempts(99, opts), 0, "a different PR must have an independent update-attempt count");

    // Must not bleed into the plain attempt counter or the chain counter (distinct stores).
    assert.equal(read(21, opts), 0, "incrementUpdateAttempt must not touch cron-counters.json");
    assert.equal(readChain(21, opts), 0, "incrementUpdateAttempt must not touch cron-chain.json");

    resetUpdateAttempts(21, opts);
    assert.equal(readUpdateAttempts(21, opts), 0, "resetUpdateAttempts must bring the PR's update-attempt count back to 0");
  } finally {
    cleanup();
  }
});

test("cron-state chain counter: increments per root issue, keyed independently, and never touches cron-counters.json", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };

    incrementChain(100, opts);
    incrementChain(100, opts);

    assert.equal(readChain(100, opts), 2, "two incrementChain calls for the same root must read back 2");
    assert.equal(readChain(999, opts), 0, "a different root must have an independent count starting at 0");
    assert.equal(
      read(100, opts),
      0,
      "incrementChain must not touch cron-counters.json — the plain attempt counter for the root stays 0"
    );
  } finally {
    cleanup();
  }
});

test("cron-state chain ceiling: atCeiling flips to true once chain depth passes the ceiling of 3", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };
    const root = 200;

    incrementChain(root, opts);
    assert.equal(atCeiling(root, opts), false, "depth 1 must be below the ceiling");

    incrementChain(root, opts);
    assert.equal(atCeiling(root, opts), false, "depth 2 must be below the ceiling");

    incrementChain(root, opts);
    assert.equal(atCeiling(root, opts), false, "depth 3 (the ceiling itself) must not yet report at-ceiling");

    incrementChain(root, opts);
    assert.equal(atCeiling(root, opts), true, "the 4th increment pushes depth past the ceiling of 3 — atCeiling must be true");
  } finally {
    cleanup();
  }
});

test("cron-state chain reset: resetChain zeroes the chain depth without touching the cron-counters.json attempt counter", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };
    const root = 300;

    increment(root, opts);
    increment(root, opts);
    assert.equal(read(root, opts), 2, "sanity: the plain attempt counter must be 2 before the chain reset");

    incrementChain(root, opts);
    incrementChain(root, opts);
    resetChain(root, opts);

    assert.equal(readChain(root, opts), 0, "resetChain must bring the chain depth back to 0");
    assert.equal(
      read(root, opts),
      2,
      "resetChain must leave the unrelated cron-counters.json attempt counter unchanged at its prior value"
    );
  } finally {
    cleanup();
  }
});

test("cron-state infra-failure store: increments per pr:sha, keyed independently by sha, and never touches other stores", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };

    assert.equal(readInfraFailure(5, "sha-a", opts), 0, "a fresh pr:sha must read back 0 infra-failures");

    incrementInfraFailure(5, "sha-a", opts);
    incrementInfraFailure(5, "sha-a", opts);
    assert.equal(readInfraFailure(5, "sha-a", opts), 2, "two increments for the same pr:sha must read back 2");

    // A different sha (new push) is an independent keyspace — the counter zeroes naturally.
    assert.equal(readInfraFailure(5, "sha-b", opts), 0, "a different sha for the same PR must be an independent count");
    // A different PR is also independent.
    assert.equal(readInfraFailure(9, "sha-a", opts), 0, "a different PR must be an independent count");

    // Must not bleed into the plain attempt counter or the chain counter (distinct stores).
    assert.equal(read(5, opts), 0, "incrementInfraFailure must not touch cron-counters.json");
    assert.equal(readChain(5, opts), 0, "incrementInfraFailure must not touch cron-chain.json");
  } finally {
    cleanup();
  }
});

test("cron-state infra-failure ceiling: atInfraFailureCeiling is false below 3 and true once it reaches 3", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const opts = { stateDir };
    const pr = 12;
    const sha = "sha-x";

    assert.equal(atInfraFailureCeiling(pr, sha, opts), false, "0 failures must be below the ceiling");

    incrementInfraFailure(pr, sha, opts);
    assert.equal(atInfraFailureCeiling(pr, sha, opts), false, "1 failure must be below the ceiling");

    incrementInfraFailure(pr, sha, opts);
    assert.equal(atInfraFailureCeiling(pr, sha, opts), false, "2 failures must be below the ceiling");

    incrementInfraFailure(pr, sha, opts);
    assert.equal(atInfraFailureCeiling(pr, sha, opts), true, "reaching 3 failures must flip atInfraFailureCeiling to true");
  } finally {
    cleanup();
  }
});

test("cron-state breaker: stays tripped within the 21600s window at the limit, and rolls over (untripped) once the window elapses", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const windowStart = 1_000_000;

    for (let i = 0; i < 12; i += 1) {
      recordReviewSession({ stateDir, now: windowStart });
    }

    assert.equal(
      breakerTripped({ stateDir, now: windowStart + 1 }),
      true,
      "at the limit of 12 sessions, still inside the 21600s window, the breaker must be tripped"
    );

    assert.equal(
      breakerTripped({ stateDir, now: windowStart + 21_600 }),
      false,
      "once now >= windowStart + 21600, the window rolls over, the count resets, and the breaker must not be tripped"
    );
  } finally {
    cleanup();
  }
});

test("cron-state breaker: count rises by one per recordReviewSession call and only trips once it reaches the real limit of 12", () => {
  const { dir: stateDir, cleanup } = makeStateDir();
  try {
    const now = 2_000_000;

    for (let i = 1; i <= 11; i += 1) {
      recordReviewSession({ stateDir, now });
      assert.equal(
        breakerTripped({ stateDir, now }),
        false,
        `after ${i} real increments (below the limit of 12) the breaker must not be tripped`
      );
    }

    recordReviewSession({ stateDir, now });
    assert.equal(
      breakerTripped({ stateDir, now }),
      true,
      "after the 12th real increment (reaching the limit) the breaker must flip to tripped"
    );
  } finally {
    cleanup();
  }
});
