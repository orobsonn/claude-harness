# Pi: interrupted parallel runs, 2026-09-13

Source baseline: `c73ec5c` (v3.0.0 plus operational lessons). Diagnosis uses
native session JSONL, persisted receipts and the actual task worktrees. This is
not evidence that every failure is a harness defect or that recovery is complete.

## Findings

| Run | Observed stop | Cause and scoped correction |
| --- | --- | --- |
| Lainny #18, parent `73cd1924-1503-4b02-9ff0-332900579a3a` | Two final review rounds returned approval but all receipts remained `running` | Parent requested `verdict` in addition to `issues`/`follow_ups`; strict Pi completion parser rejected it silently. Normalize only a consistent redundant APPROVE/REVISE; contradictory verdicts still fail. Persist invalid-completion diagnostics for the exact current dispatch. |
| Victor #237, parent `b15c8608-c0e0-4a28-b647-1e1a657699e2` | Seven task-2 launches; repeated successful capture followed by host rejection | Host reconciliation changed HEAD; native capture replay correctly preserved the producer SHA, but the inspector required that old SHA to descend from the merge. Accept the native post-reconciliation capture origin bound to the same producer and current clean HEAD, retaining dependency/scope/fidelity/review proof. |
| Lainny #92, parent `a8d8a12d-501a-471a-a341-f4229c342334` | Task-5 reported RED and upstream task-3 defect; host surfaced only test-only capture failure | An implementation had not been captured before corrective test authors. That rejection remains valid. Return the already validated child context with this failure so the parent can repair the upstream defect before recovering downstream provenance. |
| Victor #228, parent `9788fe7f-c96a-4e2d-8fd2-fbd29bf1fc5f` | Product PR #348 merged, release preparation PR #349 merged, publication denied | Version became 0.21.0 but the changelog added its note only under Unreleased, with no 0.21.0 section. Publication rejection is correct. Preserve it and instruct the shipper to perform Claude's changelog rotation before merging release preparation. |

No evidence here establishes OAuth or memory exhaustion as the cause of these
four stops. Do not infer that from a stopped terminal alone.

## Reproduction and validation

- Original focal suite: 139 passing tests. New consistent-verdict fixture failed
  with `report keys are not canonical` on the baseline.
- New host-reconciliation fixture failed on baseline with `current hand requires
  a new capture after dependency reconciliation`.
- With the patch, read-only inspection of the actual #237 task-2 registry entry
  succeeds at HEAD `1a8dc15947ae4233ce8e3b17a000543e8f7d6f8d`, retaining producer
  capture `037c36239be5cc029c39b7491001e9206277f4ab` and all existing valid eyes.
  No session, receipt or worktree content was rewritten by the probe.
- Read-only inspection of actual #92 task-5 at
  `7754125577111ee7731825ecc683df3fdbb52b2d` still rejects the missing original
  capture, now returning its current context: six RED client tests, task-3 expiry
  comparison defect, and task-5 capability replay/upstream-body findings.
- Native review-status adapter: 12 tests passed, including persisted invalid
  reason after reopening and no fabricated approval.
- Release-preservation and runtime-prompt tests: 53 passed. Invalid Unreleased-only
  release is rejected before and after merge; correct changelog rotation remains
  accepted. This is preservation, not a new publication bypass.

The full Pi/repository suites, independent reviews, distributed artifact and
actual recoveries must be recorded before claiming completion. Tests run outside
the filesystem sandbox where the Pi SDK requires native runtime access; sandbox
process visibility is not authority for declaring an existing parent dead.

## Recovery in progress

At 01:48 UTC the existing #92 parent accepted the recovery brief and resumed
task-3 with the same attempt and child session through `harness_tasks resume`.
Other tasks and integrations were retained. Restarting a process with the old
capture inspector cannot fix #237; distribute the source correction officially
before its next inspection. Never manually fabricate accepted receipts, reset
the task registry, vendor runtime by copying directories, or re-run writers only
to confirm an unchanged HEAD.
