---
name: harness-planning
description: Use after a design is approved and before a multi-step implementation.
---

# harness-planning

Write a task-by-task TDD plan after the design is approved.

Before decomposing, read root `CONTEXT.md` directly when present to use the
operator's business meanings in task descriptions and judgments. Read it yourself
even in a fresh child context; do not assume the parent supplied the glossary.
If absent, continue from the approved design and code; do not create it or
request it just to plan. It supplies vocabulary, not additional delivery scope.

- Each task names files, interfaces, failing test, expected failure, minimal code, green test, and verification command.
- Order steps by dependency and make every handoff independently checkable.
- Mark sensitive paths, rollback, blast radius, and required model route.
- Avoid placeholders, giant refactors, and tests that merely repeat prose.

Before naming test paths, inspect existing tests, runner configuration and
project instructions. Follow any established test layout for new tests; never
move existing tests just to apply a default. If none exists, put all new test
files under one root `tests/` directory, grouped by domain or feature, with
fixtures there too. Scope runner configuration in the first task that adds
tests so it discovers `tests/`. An empty repository does not override an
explicit project convention.

For a Pi session that uses `task_pipeline_version: 1`, decompose plan tasks so each
implementation can run in an isolated worktree. Declare complete `depends_on`,
`scope_paths`, `locked_tests[].path`, and `fixture_paths`; shared or ancestor paths
make tasks conflict, so use dependencies when they cannot run safely together.
Keep aggregate verification, harvest, final review, and shipping with the global
parent rather than inventing a parent-only implementation task. This Pi-specific
decomposition does not change planning or dispatch for other hosts.

Within this Pi task pipeline:

- Validate each planned RED on its exact base plus integrated dependencies. Prefer
  an existing entry point when it exercises the approved behavior, but do not
  require an artificial caller for a genuinely new standalone module.
- A missing production module is expected RED only when its resolved path is
  exactly an explicitly planned production entry in `scope_paths` and the locked
  test imports it directly. This narrow new-SUT exception permits collection to
  stop at that exact missing entry; retain the focal command's native error/path
  and concrete behavioral assertions for fidelity review. Its creation is already
  authorized, so do not request extra scope solely because the module is absent.
  Wrong paths, transitive missing modules, missing dependencies/helpers/fixtures,
  and import/export errors after the planned file exists remain invalid RED.
- Never ask the test-author to add production scaffolds, stubs, fallback mocks,
  file-existence guards or export inventories to make collection pass. Keep module
  creation and its behavior in the same task; the executor must make the original
  behavioral tests GREEN. Do not use a fake foundation or `no_tests` task.
- Treat `adversarial.enabled` as additional task-specific risk focus. `false` remains
  correct for ordinary low-risk work and does not disable the Pi pipeline's mandatory
  post-implementation adversary and re-gate; do not invent focus to encode that baseline.

`.codex/lib/plan-contract.mjs` validates a frozen, explicit TDD plan without
retaining state. `.codex/lib/review-contracts.mjs` exposes advisory complexity
scoring only; unknown or sensitive work stays at the conservative route regardless of score.

Use the template and gates in `.codex/skills/harness-delivery/references/delivery-contract.md`; apply
`.codex/skills/harness-rules/references/governance-contract.md` before closing a FULL plan.
