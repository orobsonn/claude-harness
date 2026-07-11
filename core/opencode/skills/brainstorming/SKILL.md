---
name: brainstorming
description: "You MUST load and follow this before ANY creative/dev work in LIGHT or FULL mode — before writing a spec, dispatching the planner, or any implementation. It elicits the operator's non-codifiable decisions one question at a time, proposes approaches, and HARD-GATES on an approved design. Skipping it makes the model FABRICATE product decisions the operator never made — the single biggest source of silently-wrong output."
license: MIT
compatibility: opencode
metadata:
  phase: spec
  gate: hard
---

# Brainstorming Ideas Into Designs

Turn an idea (issue, request) into a fully-formed design and spec through natural collaborative dialogue **with the operator**.

This skill runs inside the `build` (primary) agent — it asks the operator and waits for answers. It is **never** run in a headless subagent. Its output is the approved spec that Phase 1 hands to the `planner`.

Start by understanding the current project context, then ask questions **one at a time** to refine the idea. Once you understand what you're building, present the design and get operator approval.

<HARD-GATE>
Do NOT produce a final spec, dispatch the planner, write code, or take any implementation action until you have presented a design and the operator has approved it. This applies to EVERY task regardless of perceived simplicity.
</HARD-GATE>

## Why this exists (the root failure it prevents)

The issue/request is the **start of a conversation**, not a complete specification. The decisions that matter most — intervals, what's included/excluded, weighting, scope boundaries, tradeoffs — are **non-codifiable operator judgments**: they cannot be derived from the issue text or the codebase. If you skip elicitation and write the spec yourself, you will invent plausible-but-wrong decisions (a generic default that the operator never chose), and every downstream role will faithfully optimize the wrong target. **Elicit these decisions; never re-derive them.**

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every task goes through this. "Simple" tasks are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences), but you MUST present it and get approval.

## Checklist (in order)

1. **Explore project context** — files, docs, recent commits, the relevant `AGENTS.md`/nested rules.
2. **Decompose if oversized** — if the request spans multiple independent subsystems, flag it and help split into sub-projects before refining details. Each sub-project gets its own spec → plan → implementation cycle.
3. **Ask clarifying questions** — one at a time. Understand purpose, constraints, success criteria, and every non-codifiable decision the operator owns.
4. **Propose 2–3 approaches** — with trade-offs; lead with your recommendation and why.
5. **Present design** — in sections scaled to complexity; get approval after each section. Cover architecture, components, data flow, error handling, testing.
6. **Capture locked decisions** — record each decision the operator settled as an explicit, **non-negotiable constraint** in the spec (its own clearly-marked section). These are the operator's domain judgments; downstream roles (adversary, compliance) must DEFEND them, not optimize them. Persist each locked decision to `.opencode/decision-ledger.md` using entries with id | decision | operator_resolution — this ledger is the authoritative record for downstream roles (adversary, compliance) to check that the implementation does not violate the operator's locked choices.
7. **Write design doc** — save to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and commit (via `committing-changes`).
8. **Spec self-review** — inline check for placeholders, contradictions, ambiguity, scope.
9. **Operator reviews written spec** — ask the operator to review the spec file before proceeding.
10. **Transition** — hand the approved spec back to `build` Phase 1 (dispatch `planner`). Do NOT invoke any other skill.

## The Process

**Understanding the idea:**
- Check the current project state first (files, docs, recent commits).
- Assess scope before detailed questions; decompose oversized requests rather than refining a project that should be split.
- Ask questions one at a time. Prefer multiple choice (present as text — `(a)/(b)/(c)`), but open-ended is fine.
- Only one question per message. Focus on purpose, constraints, success criteria — and surface every decision the operator must own (the ones you'd otherwise guess).

**Exploring approaches:**
- Propose 2–3 approaches with trade-offs, conversationally, leading with your recommendation and reasoning.

**Presenting the design:**
- Once you understand what you're building, present it. Scale each section to its complexity (a few sentences if straightforward, up to ~300 words if nuanced).
- Ask after each section whether it looks right. Be ready to go back and clarify.
- Design for isolation: break the system into small units with one clear purpose, well-defined interfaces, independently testable. If you can't say what a unit does / how to use it / what it depends on, the boundaries need work.

**Working in existing codebases:**
- Explore the current structure before proposing changes; follow existing patterns. Include only targeted improvements that serve the current goal — no unrelated refactoring.

## After the Design

**Documentation:**
- Write the validated design to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` (operator preferences override this default). **When run inside `build` (whose `edit` is denied), write the file via bash** (`cat > docs/...`), the same pattern build uses for `shared_context.md` — do not try the edit/write tool.
- Commit the design document (via `committing-changes`).

**Spec self-review** — look with fresh eyes:
1. **Placeholder scan** — any "TBD"/"TODO"/incomplete/vague? Fix.
2. **Internal consistency** — do sections contradict? Does architecture match the feature?
3. **Scope check** — focused enough for one plan, or needs decomposition?
4. **Ambiguity check** — could a requirement be read two ways? Pick one, make it explicit.
5. **Locked-decisions check** — is every operator-owned decision recorded as an explicit non-negotiable constraint, with its rationale? If any is implicit or model-derived, go back and confirm it with the operator.

Fix issues inline; no need to re-review.

**Operator Review Gate:**
> "Spec written and committed to `<path>`. Please review it and tell me if you want changes before we write the implementation plan."

Wait for the operator. If they request changes, make them and re-run the spec review. Only proceed once approved.

**Transition:**
- Hand the approved spec to `build` Phase 1 (the `planner` dispatch). Do NOT invoke any other skill.

## Key Principles

- **One question at a time** — don't overwhelm.
- **Multiple choice preferred** — easier to answer (present as text).
- **Elicit, never re-derive** — operator-owned decisions are captured from the operator, not invented.
- **YAGNI ruthlessly** — remove unnecessary features.
- **Explore alternatives** — always 2–3 approaches before settling.
- **Incremental validation** — present, get approval, move on.
- **Be flexible** — go back and clarify when something doesn't make sense.
