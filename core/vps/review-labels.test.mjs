/**
 * @description Frozen contract test for the shared STATE_LABELS constant (AC-3.5). Pins the single
 * source of truth reused by every relabel strip call site (cron-review awaiting-merge route,
 * review-merge reconcile + mergeAndFinalize). RED until core/vps/review-labels.mjs exports the
 * exact ordered set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { STATE_LABELS } from "./review-labels.mjs";

test("AC-3.5 STATE_LABELS is the exact ordered lifecycle set (single source of truth)", () => {
  assert.deepEqual(
    [...STATE_LABELS],
    ["harness:ready", "harness:in-progress", "harness:in-review", "harness:queued"]
  );
});
