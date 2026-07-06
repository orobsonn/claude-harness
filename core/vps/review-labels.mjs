/**
 * @description Single source of truth for the harness issue STATE labels — the mutually-exclusive
 * lifecycle states an issue moves through (ready -> in-progress -> in-review -> awaiting-merge/done,
 * with queued as the dependency-gated hold). Every relabel call site strips this exact set before
 * adding the new state, so an issue never accumulates two harness:* state labels at once (the defect
 * that let a shipped issue carry both harness:ready and harness:awaiting-merge and be re-dispatched).
 *
 * `harness:awaiting-merge` and `harness:done` are the two TERMINAL states and are deliberately NOT in
 * STATE_LABELS — a strip set includes them explicitly only where the transition targets `done`
 * (reconcile / mergeAndFinalize add `harness:awaiting-merge` to the set to sweep it too). Domain
 * labels (`tier-N`, `kaizen`, `P0`, `size:*`) are NEVER touched by a state transition.
 *
 * This module is a LEAF: it imports nothing from the harness, so both cron-review.mjs and
 * review-merge.mjs can import STATE_LABELS from it with no import cycle.
 */

/** @description The non-terminal, mutually-exclusive harness lifecycle state labels (ordered). */
export const STATE_LABELS = Object.freeze([
  "harness:ready",
  "harness:in-progress",
  "harness:in-review",
  "harness:queued",
]);
