---
name: harness-planning
description: Use after a design is approved and before a multi-step implementation.
---

# harness-planning

Write a task-by-task TDD plan after the design is approved.

- Each task names files, interfaces, failing test, expected failure, minimal code, green test, and verification command.
- Order steps by dependency and make every handoff independently checkable.
- Mark sensitive paths, rollback, blast radius, and required model route.
- Avoid placeholders, giant refactors, and tests that merely repeat prose.

For a Pi session that uses `task_pipeline_version: 1`, decompose plan tasks so each
implementation can run in an isolated worktree. Declare complete `depends_on`,
`scope_paths`, `locked_tests[].path`, and `fixture_paths`; shared or ancestor paths
make tasks conflict, so use dependencies when they cannot run safely together.
Keep aggregate verification, harvest, final review, and shipping with the global
parent rather than inventing a parent-only implementation task. This Pi-specific
decomposition does not change planning or dispatch for other hosts.

`.pi/harness/vendor/codex/lib/plan-contract.mjs` validates a frozen, explicit TDD plan without
retaining state. `.pi/harness/vendor/codex/lib/review-contracts.mjs` exposes advisory complexity
scoring only; unknown or sensitive work stays at the conservative route regardless of score.

Use the template and gates in `.pi/harness/skills/harness-delivery/references/delivery-contract.md`; apply
`.pi/harness/skills/harness-rules/references/governance-contract.md` before closing a FULL plan.
