---
name: oc-brainstorming
description: "You MUST load and follow this before ANY creative/dev work in LIGHT or FULL mode — before writing a spec, dispatching the planner, or any implementation. It elicits the operator's non-codifiable decisions one question at a time, proposes approaches, and HARD-GATES on an approved design. Skipping it makes the model FABRICATE product decisions the operator never made — the single biggest source of silently-wrong output."
license: MIT
compatibility: opencode
metadata:
  phase: spec
  gate: hard
---

# Brainstorming Ideas Into Designs

Turn an idea (issue, request) into a fully-formed design and spec through natural collaborative dialogue **with the operator**.

## Plan conversational branch

When the invoking primary agent is `plan`, this branch overrides every delivery instruction below:

1. Explore relevant project context with read-only tools and use web research when it resolves a material unknown.
2. Ask one operator-owned question at a time, compare 2-3 viable approaches, and capture settled choices as locked decisions in the conversation.
3. For non-trivial technical decisions, invoke only `discussion-adversary`, then incorporate its honest critique.
4. Return the `## Build Spec` contract defined by the `plan` agent. Use `DRAFT` while blocking questions remain and `READY` only when acceptance criteria are observable and the required adversarial pass is complete.
5. Stop. Do not write `.opencode/decision-ledger.md`, runtime specs, or design docs; do not call `classify`, `mark`, `planner`, `oc-orchestrating-delivery`, or any delivery role.

The operator can then switch to `build` with Tab in the same session. `build` consumes the conversational Build Spec and starts its normal entry policy. Never infer that switching agents authorizes implementation while still running as `plan`.

This skill runs inside the `build` (primary) agent. Its output is the approved (or multi-agent-validated) spec that Phase 1 hands to the `planner`.

## Interactive vs headless

- **INTERACTIVE:** ask the operator **one question at a time**; present design; wait for approval.
- **Autonomy directive — AUTONOMOUS (local):** when the operator explicitly says "sem parar", "sem me perguntar", or
  equivalent, use the HEADLESS evidence-and-adversary workflow without waiting. This is prompt-level
  delegation only: OpenCode does not inject a continuation or re-open an idle session.
  Ask only when two viable choices change the observable product behavior or contract; select and record
  the least-invasive engineering option when the contract is the same.
- **HEADLESS** (autonomous / VPS cron / `$HARNESS_OBSERVABILITY_RUN_PATH` / `$HARNESS_OC_DATA_HOME` / trigger says "without asking"): **do not wait for a human**. Simulate exploration with **read-only** investigation + optional fan-out `task` exploration lenses (user-journeys, edge-cases, constraints), synthesize a spec from the trigger + codebase, then run one primary **spec-adversary**. Dispatch an optional second eye only when routing explicitly configures one via `secondEyeModel` or legacy `families.family-2`; catalog presence alone is not authorization. If blocking product decisions cannot be resolved from the trigger, stop and comment on the issue/PR — do not invent product judgments silently.

Start by understanding the current project context (files, MEMORY, AGENTS). Interactive: refine with the operator. Headless: refine from trigger + investigation.

<HARD-GATE>
**INTERACTIVE:** Do NOT produce a final spec, dispatch the planner, write code, or implement until you have presented a design and the operator has approved it.
**AUTONOMOUS:** Do NOT dispatch the planner until a written spec exists AND the upfront adversary pass has
run. The adversary validates engineering completeness; it never substitutes an unresolved product choice.
**HEADLESS:** Do NOT dispatch the planner until a written spec exists AND the upfront adversary pass has run (blocking issues stop the run). Operator approval is replaced by multi-agent validation — never "auto-approve blindly" without investigation + adversary.
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
7. **Write design doc** — save the canonical runtime spec to `.opencode/plans/<sessionID>-<feature_id>/spec.md`; optionally mirror it to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` and commit the docs copy (via `oc-committing-changes`).
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
- Write the validated design to the canonical runtime path `.opencode/plans/<sessionID>-<feature_id>/spec.md`. Optionally mirror it to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md` when a durable project document is wanted. **When run inside `build`, write it directly with the edit tool** (`agents/build.md`: `edit: allow`) — older revisions of this skill said `edit` was denied there and instructed a bash workaround; that predates the current `build.md` and no longer applies.
- Commit only the durable docs copy (via `oc-committing-changes`); the runtime spec remains session state.

**Spec self-review** — look with fresh eyes:
1. **Placeholder scan** — any "TBD"/"TODO"/incomplete/vague? Fix.
2. **Internal consistency** — do sections contradict? Does architecture match the feature?
3. **Scope check** — focused enough for one plan, or needs decomposition?
4. **Ambiguity check** — could a requirement be read two ways? Pick one, make it explicit.
5. **Locked-decisions check** — is every operator-owned decision recorded as an explicit non-negotiable constraint, with its rationale? If any is implicit or model-derived, go back and confirm it with the operator.

Fix issues inline; no need to re-review.

**Operator Review Gate (INTERACTIVE only):**
> "Spec written and committed to `<path>`. Please review it and tell me if you want changes before we write the implementation plan."

Wait for the operator. If they request changes, make them and re-run the spec review. Only proceed once approved.

**ALL MODES:** after approval/validation, call the native `mark` tool once with `action: brainstormed`; after the required primary spec-adversary result is accepted, call it once with `action: adversary_fired`. Persist both, in that order, before planner dispatch. HEADLESS skips only the human wait. Privileged markers never run through Bash.

**Transition:**
- Hand the approved (or headless-validated) spec to `build` Phase 1 (the `planner` dispatch). Do NOT invoke any other skill.

## Key Principles

- **One question at a time** — don't overwhelm.
- **Multiple choice preferred** — easier to answer (present as text).
- **Elicit, never re-derive** — operator-owned decisions are captured from the operator, not invented.
- **YAGNI ruthlessly** — remove unnecessary features.
- **Explore alternatives** — always 2–3 approaches before settling.
- **Incremental validation** — present, get approval, move on.
- **Be flexible** — go back and clarify when something doesn't make sense.
