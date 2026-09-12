# Host reconciliation before final review

Baseline: origin/main v2.6.25 (`b03bf73`). Reproduction: Victor #207, parent
`2cdf20c3-23b8-4167-81ea-ce28afa4d4f8`.

The LIGHT receipt fix worked: at 17:07:06 UTC, task-1 was integrated natively at
child `27a7d4b00bfd19421d0285e578d36b389ce7fe1b`, without another launch or hand.
The parent HEAD became `cb0cc23cdf8cf54000b62ef0427d4c3b5c2c319f`.

The parent then needed upstream `9de8bcc113686634dcb0b288004e7996a6ee8e83` before
final review. Its `harness_memory reconcile` call was denied because finalization
had not started. Its later ordinary `git merge origin/main` was also denied by
the coordinator Bash rail, which intentionally delegates product mutations.
Neither a task nor a writing hand owns this global integration.

The first call used an abbreviated base SHA, an independent argument error.
Replaying with both full SHAs still hit the finalization precondition. An early
final-review batch then found only historical vendor scope in the old merge base;
reviewing or harvesting to unlock the base merge would create avoidable work.

## Minimal correction

Remove the finalization prerequisite from the existing global host operation.
It already validates parent identity, exact expected HEAD/base commit, clean tree,
Git's preview, excluded paths and hash-bound memory-only conflict resolutions.
Those checks—not the presence of an earlier approval—define its authority.

No ordinary Bash merge allowance, second reconciler, task-count gate or synthetic
review is added. No task/approval receipt is rewritten. Final eyes and harvest
still validate their actual input after a merge; negative receipts are not approved.
Prose directs needed base integration before final eyes, without requiring routine
merges when no base update is needed.

## Evidence

- Baseline memory/adapter suite: 52/52 green.
- Two new pre-review cases failed on the exact finalization error before the fix.
- Clean and memory-conflicted pre-review merges pass after the fix, leaving state
  byte-identical, finalization unopened and both final reviewers still missing.
- Existing post-finalization, child denial, unsafe path/proposal, stale HEAD and
  product-conflict cases remain green (14 focused assertions/subtests).
- Real parent preview with the patched function returns a clean merge tree
  `e8ce526ff8adfa0181bcdbe390688e091a4b06f6` and five changed upstream paths.
  `applied:false`, no conflicts, registry unchanged. This is not an operational
  merge claim: release/vendor and native recovery remain required.
- The distributed extension loaded through Pi's real extension loader also passed
  preview and an actual Git merge in isolated repositories, both before and after
  final review, preserving the gate-state bytes. Package/vendor/bootstrap and the
  materialized agent/tool instructions were inspected outside the source tree.
- Independent read-only adversary and compliance each approved after 14 focused
  cases; neither changed a consumer nor claimed the pending dogfood was finished.

Separate operational observations: initial TUI resumption showed no new native
event until terminal interrupt input; the same Pi process then continued. The
exact startup cause was not established and no runtime files were patched for it.
The vendor CI took 16m47s but completed green; cancellation requested just afterward
was refused because it was already complete. No CI rerun was needed.
