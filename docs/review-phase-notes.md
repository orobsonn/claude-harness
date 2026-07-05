# Independent PR-review phase — operator notes

The review phase (v0.24.0 + the spawnReviewSession actuator) reviews a PR **diff** with
fresh eyes (adversary + compliance + security), derives the merge verdict deterministically
in the Node layer, and routes: eligible → merge; not-eligible → awaiting-merge; reject →
re-queue on the same branch.

Only machine-origin PRs are reviewed: branch `harness/*` (primary) or the `harness:autoreview`
label together with an engine-known cross-check. A human `fix/*` branch is never touched.
