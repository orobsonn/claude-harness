/**
 * @description Pins AC-1.1 of issue #251 — resolveRunPlansDir returns the run's per-worktree
 * `.claude/plans` dir to purge, or null when the removal must be SKIPPED (the operator's live
 * primary tree, or a missing/invalid worktreePath/projectRoot).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { resolveRunPlansDir } from "./cron-a-dispatch.mjs";

test("#ac-1.1 resolveRunPlansDir: a normal per-run worktree returns the run's plans dir", () => {
  const worktreePath = "/tmp/wt/harness-9";
  const result = resolveRunPlansDir(worktreePath, "/tmp/project");
  assert.equal(result, join(worktreePath, ".claude", "plans"));
});

test("#ac-1.1 resolveRunPlansDir: SKIP (null) when the worktree resolves to the same dir as projectRoot", () => {
  assert.equal(resolveRunPlansDir("/tmp/project", "/tmp/project"), null);
});

test("#ac-1.1 resolveRunPlansDir: SKIP (null) even with a trailing-slash / non-normalized variant", () => {
  assert.equal(resolveRunPlansDir("/tmp/project/", "/tmp/project"), null);
  assert.equal(resolveRunPlansDir("/tmp/project", "/tmp/project/"), null);
});

test("#ac-1.1 resolveRunPlansDir: SKIP (null) on a missing/empty/non-string worktreePath", () => {
  assert.equal(resolveRunPlansDir(undefined, "/tmp/project"), null);
  assert.equal(resolveRunPlansDir("", "/tmp/project"), null);
  assert.equal(resolveRunPlansDir(123, "/tmp/project"), null);
});

test("#ac-1.1 resolveRunPlansDir: SKIP (null) on a missing/empty projectRoot", () => {
  assert.equal(resolveRunPlansDir("/tmp/wt/harness-9", undefined), null);
  assert.equal(resolveRunPlansDir("/tmp/wt/harness-9", ""), null);
});
