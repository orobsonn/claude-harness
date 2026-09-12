# LIGHT task blocked by an implementation-review marker

Baseline: `origin/main` v2.6.24 (`ba96aeb`). Real reproduction: Victor issue #207,
new session `2cdf20c3-23b8-4167-81ea-ce28afa4d4f8`, child
`835c51c7-47b9-4a54-a349-5d98746d1121`, attempt
`383c3d3a-9cb6-43b8-b2f5-d893a09e7712`.

## Observed sequence

- Canonical LIGHT plan approved; task complexity medium. Native test-author and
  test-reviewer completed RED and fidelity. Executor changed the SQL predicate;
  focused tests 14/14 and typecheck passed.
- Implementation/capture HEAD: `27a7d4b00bfd19421d0285e578d36b389ce7fe1b`.
  `capture-verified` succeeded at 16:04:53.045 UTC on 2026-09-12.
- Task review status returned `required: [], accepted: [], missing: []`.
- The executor completion adapter had nevertheless written `regate_pending`.
  Task inspection asked the child to close that marker; `mark regate-passed`
  rejected it because no current implementation-review receipt existed.
- Two operational resumptions did not change product or add a reviewer. The run
  was paused with three launches total, retaining the implementation and evidence.

Sanitized minimal state/event fixture (implemented near task-receipts tests):

```json
{
  "plan": { "mode": "light" },
  "capture": "valid native implementation at current HEAD",
  "fidelity": "valid native reviewed freeze",
  "review_receipts": {},
  "regate_pending": ["feature/task-1"],
  "regate_passed": []
}
```

The baseline adapter/inspection suite passed 96/96 before adding the regressions.
The new adapter LIGHT case and legacy pending inspection case each failed on the
baseline, reproducing the contradiction. FULL completion and negative-review cases
were already green.

## Minimal correction

The completion adapter does not arm an implementation-review marker in classified
LIGHT. Missing/unknown modes retain conservative behavior. For already recorded
LIGHT attempts, inspection uses its existing canonical required/dispatched review
validation: an empty, satisfied obligation does not require a synthetic reviewer
or marker. The historical pending entry remains unchanged in the receipt.

Required or actually dispatched reviews still apply, including failed/negative
receipts. FULL marker semantics, final reviews, exact producer/capture validation,
fidelity, frozen blobs, scope and runtime binding are unchanged. No receipt is
forged, no child runtime is repinned, and no migration or policy engine is added.

## Real-state read-only probe

Using the unmodified #207 registry and native child artifacts, importing the
published inspector returns the pending re-gate error. Importing the patched
inspector returns `ok: true` at the same implementation HEAD, empty review receipts
and the original pending marker. Registry bytes were identical before/after.
This is an inspection proof, not an integration or completed dogfood claim.

Release/vendor and a native parent status/integrate after that update are still
required to prove recovery. Keep the same session and attempt; do not dispatch a
writer/reviewer simply to get past this marker.
