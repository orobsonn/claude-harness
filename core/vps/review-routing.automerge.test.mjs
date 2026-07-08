/**
 * @description Frozen regression pin for routeReject mutual-exclusivity (AC-3.4). A REJECT below the
 * chain ceiling must relabel harness:in-review -> harness:ready with no label accumulation. This
 * pins the existing transition so the label-state-machine changes elsewhere never regress it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { routeReject } from "./review-routing.mjs";

test("AC-3.4 routeReject below ceiling relabels in-review -> ready (no accumulation)", () => {
  const editCalls = [];
  function gh(args) {
    if (args[0] === "issue" && args[1] === "edit") editCalls.push(args);
    return { ok: true };
  }
  const chain = { atCeiling: () => false, increment: () => {}, reset: () => {}, read: () => 0 };
  const reviewed = { alreadyReviewed: () => false, recordReviewed: () => {} };

  routeReject(
    { number: 149, headRefName: "harness/86" },
    "deadbeef",
    { gh, chain, reviewed, recordFindings: () => {}, notify: () => {}, findings: {} }
  );

  assert.equal(editCalls.length, 1);
  assert.deepEqual(editCalls[0], ["issue", "edit", "86", "--remove-label", "harness:in-review", "--add-label", "harness:ready"]);
});
