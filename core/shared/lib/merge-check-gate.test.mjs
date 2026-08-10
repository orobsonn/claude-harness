/** @description Locked contract for the small, shared CI-before-merge policy. */
import { test } from "node:test";
import assert from "node:assert/strict";

import { decideMergeChecks, mergeTargetFromCommand } from "./merge-check-gate.mjs";

const passed = [{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }];

test("allows a reported rollup only when every check is terminal-green", () => {
  assert.deepEqual(decideMergeChecks(passed), { ok: true, state: "green" });
  assert.deepEqual(
    decideMergeChecks([
      ...passed,
      { __typename: "StatusContext", context: "lint", state: "NEUTRAL" },
      { __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" },
    ]),
    { ok: true, state: "green" },
  );
});

test("fails closed for no evidence, pending, failed, and unknown checks", () => {
  assert.equal(decideMergeChecks(null).state, "unavailable");
  assert.equal(decideMergeChecks([]).state, "missing");
  assert.equal(decideMergeChecks([{ __typename: "CheckRun", name: "test", status: "IN_PROGRESS", conclusion: null }]).state, "pending");
  assert.equal(decideMergeChecks([{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" }]).state, "red");
  assert.equal(decideMergeChecks([{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "STALE" }]).state, "unavailable");
  assert.equal(decideMergeChecks([{ __typename: "CheckRun", name: "docs", status: "COMPLETED", conclusion: "SKIPPED" }]).state, "missing");
});

test("extracts only a deterministic merge target and rejects ambiguous shell syntax", () => {
  assert.equal(mergeTargetFromCommand("gh pr merge --squash --delete-branch"), null);
  assert.equal(mergeTargetFromCommand("gh pr merge 42 --squash"), "42");
  assert.equal(mergeTargetFromCommand("gh pr merge https://github.com/acme/repo/pull/42 --squash"), "https://github.com/acme/repo/pull/42");
  assert.equal(mergeTargetFromCommand("gh pr merge --repo acme/repo 42 --squash"), undefined);
  assert.equal(mergeTargetFromCommand("gh pr merge 42 --auto"), undefined);
  assert.equal(mergeTargetFromCommand("gh pr merge 42 --squash && gh pr merge 43 --squash"), undefined);
  assert.equal(mergeTargetFromCommand("gh pr merge $PR --squash"), undefined);
  assert.equal(mergeTargetFromCommand("gh pr merge 42 43"), undefined);
});
