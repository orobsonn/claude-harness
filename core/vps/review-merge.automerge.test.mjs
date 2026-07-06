/**
 * @description Frozen contract tests for the mutually-exclusive relabel in review-merge.mjs
 * (AC-3.3). Both reconcile() and mergeAndFinalize() must strip the FULL state set
 * {harness:ready,in-progress,in-review,queued,awaiting-merge} when relabeling an issue to
 * harness:done — not the anemic single scanned label — so no residual state label leaks, while
 * domain labels (tier-1) are preserved. Hermetic: gh/counter/recordReviewed injected.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { reconcile, mergeAndFinalize } from "./review-merge.mjs";

const FULL_STRIP = [
  "harness:ready",
  "harness:in-progress",
  "harness:in-review",
  "harness:queued",
  "harness:awaiting-merge",
];

/** @description Collects the --remove-label values from a `gh issue edit` argv. */
function removedLabels(args) {
  const removed = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--remove-label") removed.push(args[i + 1]);
  }
  return removed;
}
/** @description Collects the --add-label values from a `gh issue edit` argv. */
function addedLabels(args) {
  const added = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--add-label") added.push(args[i + 1]);
  }
  return added;
}

test("AC-3.3 reconcile strips the full state set + awaiting-merge, adds done, preserves domain labels", () => {
  const editCalls = [];
  function gh(args) {
    if (args[0] === "issue" && args[1] === "list") {
      // scanned for the awaiting-merge label → issue 86 carries it
      return args.includes("harness:awaiting-merge") ? [{ number: 86, labels: ["harness:ready", "harness:awaiting-merge", "tier-1"] }] : [];
    }
    if (args[0] === "pr" && args[1] === "list" && args.includes("merged")) return [{ number: 149, state: "MERGED" }];
    if (args[0] === "pr" && args[1] === "list" && args.includes("open")) return [];
    if (args[0] === "issue" && args[1] === "edit") {
      editCalls.push(args);
      return { ok: true };
    }
    return { ok: true };
  }
  const counter = { reset: () => {} };

  reconcile({ gh, counter, stateDir: "/tmp/rm-automerge", labels: ["harness:awaiting-merge"] });

  assert.equal(editCalls.length, 1);
  const removed = removedLabels(editCalls[0]);
  for (const label of FULL_STRIP) assert.ok(removed.includes(label), `expected --remove-label ${label}`);
  assert.deepEqual(addedLabels(editCalls[0]), ["harness:done"]);
  assert.ok(!removed.includes("tier-1"), "must NOT remove the domain label tier-1");
});

test("AC-3.3 mergeAndFinalize strips the full state set on the auto-merge happy path (no residual leak)", () => {
  const editCalls = [];
  function gh(args) {
    if (args[0] === "pr" && args[1] === "merge") return { ok: true };
    if (args[0] === "issue" && args[1] === "edit") {
      editCalls.push(args);
      return { ok: true };
    }
    return { ok: true };
  }
  const counter = { reset: () => {} };
  const recordReviewed = () => {};

  const out = mergeAndFinalize(
    { number: 149, headRefName: "harness/86" },
    "deadbeef",
    { gh, counter, recordReviewed, stateDir: "/tmp/rm-automerge", sleep: () => {} }
  );

  assert.equal(out.merged, true);
  assert.equal(editCalls.length, 1);
  const removed = removedLabels(editCalls[0]);
  for (const label of FULL_STRIP) assert.ok(removed.includes(label), `expected --remove-label ${label}`);
  assert.deepEqual(addedLabels(editCalls[0]), ["harness:done"]);
  assert.ok(!removed.includes("tier-1"), "must NOT remove a domain label");
});
