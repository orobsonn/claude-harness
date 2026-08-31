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

`.codex/lib/plan-contract.mjs` validates a frozen, explicit TDD plan without
retaining state. `.codex/lib/review-contracts.mjs` exposes advisory complexity
scoring only; unknown or sensitive work stays at the conservative route regardless of score.

Use the template and gates in `.codex/skills/harness-delivery/references/delivery-contract.md`; apply
`.codex/skills/harness-rules/references/governance-contract.md` before closing a FULL plan.
