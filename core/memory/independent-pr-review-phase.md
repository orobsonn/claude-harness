---
name: independent-pr-review-phase
description: Architecture of the independent PR-review phase (cron-review.mjs + run-cron-review.mjs) that replaces the editable-PR-body auto-merge verdict with a fresh, fail-closed, cross-family conjunction — plus its known open gaps (spawnReviewSession unwired, breaker now-threading, idempotency, Cron B retirement).
metadata:
  type: project
---

**Why:** Cron B's original auto-merge read the merge verdict from the PR body text
(`parseVerdictBlock(bodyText)`), which is editable by anyone with push access — an open auto-merge
spoofing vector. The `independent-pr-review` feature replaces that with an independent review phase:
a separate cron reads a fresh, out-of-band verdict artifact and only merges on the full conjunction of
checks. Anyone extending or debugging the review/merge path needs to know the module boundaries,
the conjunction, the label taxonomy, and — critically — that the phase does not yet run in production.

**How to apply:**

- **Composition root:** `run-cron-review.mjs` is the production entry point; `cron-review.mjs` is the
  pure per-PR review/route/merge logic it drives (parallel to `cron-a-dispatch.mjs` /
  `run-cron-a.mjs` for the delivery side). `install-crons` schedules `run-cron-review.mjs` and
  **no longer schedules `run-cron-b.mjs`** — but `run-cron-b.mjs`/`cron-b.mjs` still exist on disk
  and will keep running the OLD weak verdict path on any box whose crontab isn't re-installed after
  the update (different lock scope than the review phase, so no mutual exclusion). Always re-run
  `install-crons` after pulling this change; consider making `run-cron-b.mjs` a no-op that logs
  "retired — re-run install-crons".

- **The merge conjunction (auto-merge gate):** a PR only merges when ALL of: (1) the harness/* branch
  signal (or a future `engineKnows` secondary signal — currently hardcoded `false`, so only the
  primary branch-name signal is live) confirms machine origin; (2) `review-verdict-source.mjs` reads
  a **fresh** verdict artifact from `stateDir` (`review-<prNumber>-<sha>.json`) with `status ===
  "CLEAN"` — never the PR body; (3) cross-family agreement where configured (fail-closed: if the
  cross-family check is unavailable, it defaults to NOT merging, never to merging).

- **Fresh-verdict-artifact-in-stateDir:** `review-verdict-source.mjs` is "the single trusted verdict
  source" — it reads `join(stateDir, review-<pr.number>-<sha>.json)`. This is what makes the verdict
  un-spoofable by editing the PR body. Known hardening gaps (recorded, not yet applied): no path
  validation on `pr.number`/`sha` before the `join` (a caller passing a non-numeric/non-hex value
  could traverse `stateDir`), and `JSON.parse(raw)` is returned without validating shape
  (`status` must be exactly `"CLEAN"` or `"BLOCKED"`, object, non-array).

- **Label taxonomy:** `harness:ready` → `harness:in-review` (cron-a-exit hands off, no longer jumps
  straight to `harness:done`) → `harness:awaiting-merge` (CLEAN, mainline route while cross-family
  `available:false`) → `harness:done` (merged + counter reset) / `harness:blocked` (ceiling reached).
  `review-routing.mjs` handles reject → re-enqueue to `harness:in-review` → `harness:ready` on repair.

- **CRITICAL — the phase is wired but INERT until `spawnReviewSession` is implemented.**
  `cron-review.mjs`/`run-cron-review.mjs` are fully composed and test-green, but three seams are
  intentionally fail-loud stubs, not silent no-ops:
  - `spawnReviewSession` **throws** ("no production wiring yet") — this is the seam that must spawn
    the headless `claude -p` review session running the `reviewing-pull-requests` skill (parallel to
    `cron-a-dispatch.mjs`'s session spawn). Until implemented, the phase throws on the first eligible
    unreviewed PR — it cannot review/merge anything in production yet.
  - `engineKnows` defaults to `false` (secondary machine-origin signal not yet built).
  - `recordFindings` is a no-op (repair-session findings aren't durably persisted yet).
  Before wiring `spawnReviewSession`, also fix two dependent bugs recorded as follow-ups:
  (a) **breaker now-threading**: `run-cron-review` threads `now` as a function (`() => number`,
  correct for `run-lock.acquire`), but `cron-state.breakerTripped`/`recordReviewSession` expect a
  **numeric** `now` — passing the function makes the window-rollover math `NaN`, so once the breaker
  trips (12 sessions/6h) it never auto-recovers. Fix requires invoking `now()` at every cron-state
  boundary AND correcting the frozen test's seeding (`recordReviewSession({stateDir, now: () => N})`
  currently pins the buggy function-passing behavior — the test must change alongside the fix).
  (b) **idempotency gap**: only the MERGE route calls `recordReviewed(pr.number, sha)`; the
  awaiting-merge and 2nd-pass-blocked routes do not, so an unchanged-SHA PR gets re-reviewed every
  cron cycle, marching the chain counter toward the ceiling for no reason. `review-routing.mjs`
  already calls `reviewed.alreadyReviewed(...)` but discards the boolean (dead statement) — wire it
  or add the missing `recordReviewed` calls before going live.

- **Reaper integration:** `reaper.mjs` accepts `opts.issueLabels(issueNumber) => string[]` and skips
  `crashRecover` for `harness:in-review` issues, but `run-reaper.mjs` (composition root) does not yet
  pass a real `issueLabels` — until wired, the explicit skip is inert (defaults to `[]`); the
  pre-existing `!prExists` guard still protects the common case.
