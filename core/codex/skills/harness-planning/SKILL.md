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

Within this Pi task pipeline:

- Before freezing task boundaries, confirm each planned RED can be collected on the
  exact base plus its already integrated dependencies; an import or collection
  failure is not the expected RED. A task may add and assert a new data export
  through an existing module, but its test must not import a module absent from that
  RED baseline.
- Never ask the test-author to add production scaffolds or stubs just to make test
  collection pass. Express the RED through an existing importable entry point and,
  when behavior requires a genuinely new module, combine its creation with the routed
  behavior in one task; do not use a fake foundation or `no_tests` task.

`.codex/lib/plan-contract.mjs` validates a frozen, explicit TDD plan without
retaining state. `.codex/lib/review-contracts.mjs` exposes advisory complexity
scoring only; unknown or sensitive work stays at the conservative route regardless of score.

Use the template and gates in `.codex/skills/harness-delivery/references/delivery-contract.md`; apply
`.codex/skills/harness-rules/references/governance-contract.md` before closing a FULL plan.
