---
name: harness-delivery
description: Use to execute an approved delivery plan with TDD, scoped subagents, and verification.
---

# harness-delivery

Run entry triage first and execute only an approved, bounded plan.

- Resolve role and complexity before every dispatch. A first test, implementation, or
  final eye brief names the phase, applicable canonical artifacts, observed cwd/base/HEAD/status
  (including untracked paths), relevant diffs or negative proofs, and any required real command
  output plus exit status tied to named files.
- Delegate only independent work; hands cannot widen scope or self-approve.
- For every implementation change: red test, minimal green code, affected suite.
- At the end, verify acceptance criteria, diff, docs, risks, and residuals.
- After implementation, route an applicable final finding back to its existing owning
  task for a scoped fix and revalidation. Do not create another task or dispatch planner/
  plan-reviewer to restart a finished plan; an unowned path or changed contract needs
  an explicit scope decision, never an implicit expansion during finalization.

When this skill is loaded by a Pi global parent whose session has
`task_pipeline_version: 1` and a current approved plan, use `harness_tasks` for implementation dispatch,
observation, exact-SHA integration, and same-task resume. Do not dispatch Pi
test-author, executor, sniper, or task-review eyes from the global parent; each
isolated task parent runs that native loop. This exception changes only the Pi
coordination surface. In a Pi task parent, execute the native per-task loop and
return its evidence without starting global ceremony or shipping.

The authoritative operational sequence is
`.codex/skills/harness-delivery/references/delivery-contract.md`. Apply the
security constraints from `.codex/skills/harness-rules/references/governance-contract.md`.
