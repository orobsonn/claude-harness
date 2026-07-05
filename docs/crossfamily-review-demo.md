# Cross-family review demo

This file exercises the independent PR-review phase with the REAL cross-family (Codex)
second family enabled. The Node review layer runs the three Claude eyes (adversary +
compliance + security) over this diff, then runs the Codex peer on adversary + security,
derives the canonical verdict deterministically, and routes. With `autoMergeEnabled` false
(default), an eligible PR goes to awaiting-merge for a human merge — the review runs and
produces a verdict, but never auto-merges until the rollout lock is deliberately flipped on.

Updated to force a fresh review at a new head SHA (cross-family auth-probe fixed).
