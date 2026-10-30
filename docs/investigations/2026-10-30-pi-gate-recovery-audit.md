# Pi gate recovery audit — 2026-10-30

Scope: investigate redundant delivery gates after the live victor-pipeline-dados-bot #235 stop. Source baseline: acc3ba8. No product or production deployment authority is added.

## Confirmed defect

A native test-author inspected the previously reviewed freeze without editing it. The implementation subsequently completed. A fresh test review approved the same tests, but live fidelity demanded a second author/reviewer/commit chronology. Historical receipt inspection independently rejected the later author. This required cosmetic test churn to represent an unchanged oracle and blocked the same attempt.

Correction: when no later test-only freeze exists, replay the prior successful native author/reviewer/freeze chain against current clean HEAD and its exact locked blobs; require the latest subsequent test review to approve. Keep the original implementation boundary. A failed/missing review, changed locked blob, dirty worktree, missing native chain, or unreviewed author remains blocked. Ordinary real fixture repair and aggregate-import recovery retain their existing paths.

## Confirmed redundant preflight gate

The launcher duplicated the Pi/subagent version pins already enforced by the sealed runtime and compatibility verifier. During the 1.4.0 update, its stale literal rejected an otherwise verified runtime. Remove the duplicate literal checks; retain exact version and integrity enforcement in the existing authority. Integration coverage mutates each isolated package manifest and requires refusal without repair.

## Other gate paths inspected

| Path | Evidence checked | Finding |
| --- | --- | --- |
| Capture after later commits | marker-authority.mjs capture-verified and exact producer ancestry | Already uses producer SHA; no confirmed need for a cosmetic writer. |
| Refused native writer | entry-gate.mjs completion and native-writer.mjs | Zero-tool refusal can preserve a captured hand; real deltas remain checked. |
| Review dispatch refused by a gate | task-receipts.mjs observedImplementationReviewRoles | Refused calls do not supersede an accepted review receipt. |
| Accepted task reviews after correction | pi-review-evidence.mjs isSatisfiedPiTaskReviewReceipt | Existing positive reviews can survive ancestry; a new actual review revokes that role. |
| No-op resume | task-receipts.mjs abandonment validation | Existing explicit abandonment restores historical integration without approving a blocked hand. |
| Aggregate refresh and frozen imports | task-reconciliation.mjs and task-run.mjs | Separate host import proof exists; preserve it rather than replacing it with generic chronology. |
| Harvest memory commit after final review | memory-cycle.mjs reviewed input binding and verifyMemoryShipment | Memory-only harvest has a bound continuation path; no new confirmed deadlock from reading the code. |
| Shipping and issue closure after squash | entry-gate.mjs post-merge validation | Dedicated merged-delivery path avoids demanding original ancestry after squash. |

These are bounded source findings, not a claim that every possible execution is deadlock-free. The #237 live sibling completed and merged PR #242; it is not another stopped-run reproduction. Queue readiness waits for open native GitHub dependencies and must not bypass them.
