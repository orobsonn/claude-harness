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

import { increment, reset, read, recordReviewed, alreadyReviewed } from "./cron-state.mjs";

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
