---
name: test-real-composition-root-binding
description: A frozen test must exercise the DEFAULT (real) seam binding from the composition root, not a fake injected in the test — a fake-seam test can pass green while the real wiring throws or reads the wrong data.
metadata:
  type: project
---

**Why:** The `review-sticky-verdict` fix (PR #198) landed a task-1 test that injected a fake
`routeReject`/`reviewed` pair and passed green — but the real `recordReviewed` seam is bound in
`run-cron-review.mjs` (the composition root), not in `cron-review.mjs` (the pure-logic module the
test exercised directly). Because the test never drove the real binding, it could not catch that
production threw a swallowed `TypeError` on the actual wire-up. Same failure shape recurred in a
sibling task: the ready/in-progress exclusion tests injected `stalledNotified` but not
`recordStalledNotified` — production hit `undefined(...)`, the error was swallowed by the per-PR
`catch`, the notify silently never fired, and the test still passed green because it only asserted
on the injected fake, never on the real seam being reachable end-to-end. Both were caught only by an
independent debug harness, not by the frozen test suite itself.

**Promoted to `core/` (tracked) on 2026-07-09 by the `retention-sweep-delete-stale-topics` (#178)
harvest** — this topic previously existed only in the gitignored `.claude/memory/` dogfood mirror.
That run's own `shared_context.md` cited it by name assuming it was repo-wide durable memory; it was
not tracked, so a fresh clone / CI / cloud session could not have seen it. Two MORE instances of the
same trap were found in the same delivery (below) — direct evidence the pattern is still live and the
promotion overdue.

**How to apply:**
- When a locked/frozen test injects a dependency (fake getter/setter, fake notifier), verify it
  injects **every seam the asserted code branch actually calls** — a partial fake lets an
  undefined-call TypeError get swallowed by an outer try/catch and masquerade as success.
- Prefer driving the acceptance test through the **default (real) composition-root binding**
  end-to-end over a fully-faked unit test, at least once per contract — a fake-only test proves the
  logic shape, not that the real wiring reaches it.
- A test passing green is not sufficient signal by itself: require the test to have failed
  (AssertionError-red, not broken-red/parse-error-red — see kaizen `[review-sticky-verdict] vacuous
  tests`) against the ORIGINAL code before the fix landed, proving it actually exercises the bug.
- **Require a paired POSITIVE control on the real fixture for any negative locked test on a
  destructive path** — this is the check that actually catches the trap in practice (see the two
  instances below; both fake-seam tests were green, and only a reviewer demanding the real-fixture
  positive control caught them).

**Two more instances, `retention-sweep-delete-stale-topics` (#178), task 6 `reaper-composition-root`:**
1. A frozen test injected a fake `listObsRuns` returning candidates with events already attached.
   Production's real `defaultListObsRuns` returned `{metaPath, meta}` with **no `events` key at all**
   — the real composition root never read/attached events, so in production `events` was always
   `undefined`/`[]` and the `#ac-1.4` undelivered-critical guard passed vacuously on every candidate.
   Fixed by wiring `defaultListObsRuns` to read events via `readEvents` and attach them to the
   candidate shape.
2. The blocklist-of-shared-topics logic read a flat `sharedThreadId` field that **does not exist in
   production config** — `install-crons.mjs` writes `notify.threadId`, never a top-level
   `sharedThreadId`. The frozen tests passed because their own fixtures wrote the flat field the
   production reader expected, never testing against what `install-crons.mjs` actually emits. In
   production the blocklist would have been EMPTY and the group's shared topic unprotected from
   deletion. Fixed to read `notify.threadId` (both per-project and fleet) plus the resolved notify
   config, keeping the flat field only as a test-fixture fallback.
