# OpenCode Claude-Parity Reset Design

**Status:** approved by the operator on 2026-08-13

## Goal

Make Claude Code the behavioral reference for the vendored OpenCode shell. OpenCode may keep a thin
adapter where the host APIs differ, but it must not add a workflow state machine, an automatic recovery
policy, or an extra ceremony that Claude Code does not have.

## Reference behavior

- Classification is semantic. Executable code validates and records the model's choice.
- A feature plan has one stable path: `.claude/plans/<feature>/execution-plan.json` in Claude Code and
  `.opencode/plans/<feature>/execution-plan.json` in OpenCode.
- The planner writes the plan. A deterministic write gate prevents other roles from authoring it, and
  a structural validator checks it before downstream writing roles run.
- The model owns phase progression. Host code may deny a transition contradicted by a durable fact; it
  does not select a prior session, infer approval, re-plan, retry, or wake the model.
- Compaction recovery only reminds the same session about mode, feature and stable plan.
- Native todos are bookkeeping only, never a second workflow engine.

## Remove from OpenCode

1. Cross-session feature discovery/adoption and its session-scoped plan layout.
2. Planner attempt leases, returned-plan parsing, canonical writer, content-addressed snapshots and
   planner binding lifecycle.
3. Persisted plan-review verdict receipts and legacy approval inference.
4. Bound-plan prompt injection/repair and re-review transport normalization.
5. Automatic todo projection and mandatory `todowrite` synchronization.
6. OpenCode-only recovery prose that chooses phases, replays tasks or re-plans after approval.
7. The dedicated update coordinator/lifecycle engine where the same operation can be expressed by the
   build model following the Claude Code updating skill and selective Git commands.

## Keep as platform adapters

- Native `classify` and `mark` tools, because OpenCode lacks Claude Code's Bash PostToolUse stamp hook.
- Entry, plan-write and delivery-command gates that enforce the same factual rails as Claude Code.
- Per-call scope records, frozen-test/capture records and SHA ancestry checks.
- Observability, version warning and same-session compaction reinjection.
- OpenCode model routing/configuration required to name host models; it is configuration, not workflow
  authority.

## New OpenCode flow

1. `classify` writes only session triage state and returns the stable feature plan path.
2. QUICK stays inline. LIGHT/FULL run brainstorming and planning in prose.
3. Planner writes the full plan directly to the stable path and runs `validate-plan`.
4. Plan reviewer reads that file and returns APPROVE/REVISE. No verdict is persisted as delivery
   authority; the current conversation carries the judgment, exactly as Claude Code does.
5. On an explicit operator request to resume, the build model reads the named stable plan and continues
   from durable files/git evidence. It does not dispatch planner/reviewer unless the operator asks for a
   new review or the existing plan itself is structurally invalid.

## Safety boundary

The reset does not remove deterministic scope, frozen-test, capture, ancestry, sensitive-path or merge
rails that have a Claude Code counterpart. It removes policy engines around those facts. A malformed or
missing plan still blocks a writing-hand dispatch; an infrastructure failure remains fail-open or
fail-closed according to the matching Claude Code rail.

## Acceptance

- No production reference to the removed resume/binding/todo/planner-FSM modules.
- No session id in the feature plan path.
- Planner can write the stable plan; build cannot.
- A valid stable plan lets plan-reviewer/test-author/executor run without snapshot/binding state.
- A new session explicitly told to resume does not create a new plan or automatically review it.
- Fresh vendoring loads every remaining OpenCode plugin.
- Focused tests, full suite, vendored smoke and one live OpenCode run pass.
