# Spec — Deterministic Entry-Gate (Sonnet-orchestrator enablement)

**Date:** 2026-06-11
**Mode:** FULL
**Status:** awaiting HARD-GATE 1 (spec approval)

## Problem

The operator wants **Sonnet** as the default orchestrator (highest token volume → cheapest lever; the harness already routes stronger models per role). But a weaker orchestrator **skips the ceremony**: it does not run `triaging-requests`, authors the spec itself instead of running `brainstorming`, and skips the spec-adversary. The prose in `SKILL.md`/`CLAUDE.md` is **skippable by a fallible model** — it reads the paraphrase and fakes the gate.

Proven fix (ported from the operator's OpenCode harness): a **runtime interlock** — a `PreToolUse` hook that blocks a tool call and feeds the reason back to the model, independent of the model obeying prose.

## Scope

**In:** entry-gate (triage + brainstorm-before-planner + spec-adversary-before-planner), the session-keyed `triage.json` artifact, harness-aware compaction recovery.
**Out (future phases):** plan-gate (block executor until plan validated + reviewed), loop-guard (convergence caps).

## Confirmed hook contract (probe, not docs — see memory `claude-code-hook-contract`)

- Subagent dispatch `tool_name` == **`Agent`** (NOT `Task`).
- Main-loop vs subagent: payload carries **`agent_id`** only inside a subagent (absent in main loop). The gate acts only when `agent_id` is absent.
- `Skill` tool: `tool_input.skill_name`. `Agent` tool: `tool_input.subagent_type`.
- Hooks hot-reload immediately; `session_id` stable per session.
- Block: stdout `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.
- Compaction: PreCompact only blocks (no custom summary prompt); auto-compact threshold not tunable; hooks cannot trigger `/compact`; token usage not exposed.

## User journeys

- **#uj-1 (local, weak orchestrator skips triage):** operator gives a feature request; Sonnet tries to dispatch `executor` without triaging. Gate denies; the deny reason tells it to run `triaging-requests` first. Sonnet self-corrects. Operator sees a normal, disciplined flow.
- **#uj-2 (local, casual research):** operator asks a question; Sonnet dispatches a `general-purpose`/`Explore` agent. Gate **allows** (not a delivery role). No friction.
- **#uj-3 (planner before brainstorm/adversary):** Sonnet tries to dispatch `planner` after triaging but without brainstorming + spec-adversary. Gate denies with the missing step. Self-corrects.
- **#uj-4 (headless / cloud routine):** no operator in the loop; the gate is the only thing forcing ceremony. Deny→self-correct works without a human. Config travels with the repo (committed `.claude/`).
- **#uj-5 (compaction mid-run):** Sonnet nears its context limit and auto-compacts. Post-compaction it re-reads `triage.json` + plan + `shared_context.md` and resumes without losing the thread.

## Acceptance criteria

- **#ac-1.1** A delivery-role `Agent` dispatch (`planner|executor|compliance|adversary|sniper|security|harvester|shipper|plan-reviewer`) in the main loop (no `agent_id`) is **denied** unless a `triage.json` for the current `session_id` exists with `mode ∈ {LIGHT, FULL}`.
- **#ac-1.2** A non-delivery subagent (`general-purpose`, `Explore`, `claude`, etc.) is **always allowed**.
- **#ac-1.3** Any `Agent` call carrying `agent_id` (subagent context) is **always allowed** (no state pollution).
- **#ac-2.1** A `planner` dispatch is **denied** unless `brainstorming` fired this session **AND** a `spec-adversary` (`subagent_type=adversary`) was dispatched this session — in **both** LIGHT and FULL.
- **#ac-3.1** `triage.json` is written by the **PostToolUse hook** with `session_id` taken from the hook payload (never model-supplied). `feature_id` validated kebab-case ≤64 chars; `mode ∈ {no-ceremony, QUICK, LIGHT, FULL}`; atomic write; never throws.
- **#ac-4.1** Any infra error in any gate hook (parse, fs, lock, missing node) results in **allow** (`exit 0`). Only the gate decision branch emits `deny`. (Fail-open infra / fail-closed gate.)
- **#ac-5.1** `core/CLAUDE.md` carries a `# Compact instructions` section preserving phase, `mode`, plan path, and gate state.
- **#ac-5.2** A `SessionStart` hook (`matcher: compact`) re-injects the current `triage.json` + plan summary after compaction.
- **#ac-6.1** Opt-in is by adoption: a project with the harness `.claude/settings.json` + `.claude/hooks/` has the gate; a project without does not. Hook commands use `${CLAUDE_PROJECT_DIR}` so they travel with the repo (routines-compatible).
- **#ac-6.2** State files (`.claude/plans/<session_id>/gate-state.json`) are GC'd on SessionStart (older than N days removed).

## Resolved product decisions

- **Gate scope:** only delivery roles are gated; casual research subagents run free. (operator)
- **Opt-in:** per-project, committed to the repo (so cloud routines work); not global-always. (operator)
- **Spec-adversary is mandatory** after every spec, both LIGHT and FULL — the operator cannot judge engineering triviality, so the judgment is removed and the step is unconditional. Requires aligning `orchestrating-delivery/SKILL.md` (FULL currently defers adversarial to per-task). (operator)
- **Per-task adversarial stays judgment** — planner sets `task.adversarial.enabled`, plan-reviewer audits. The gate does not touch it. (operator)

## Constraints

- All hook scripts: Node, no external deps, read stdin once, always `exit 0` on any error path.
- Gate logic is keyed by `session_id`; only main-loop calls (no `agent_id`) are evaluated.
- Harness language convention: English artifacts; operator messages pt-br product-language.
- Files live in `core/` (source of truth), vendored into a project's `.claude/`.

## Affected artifacts

- New: `core/hooks/classify.mjs`, `core/hooks/stamp-triage.mjs`, `core/hooks/entry-gate.mjs`, `core/hooks/reinject-state.mjs`.
- Edit: `core/settings.json` (wire PreToolUse `Agent`, PostToolUse `Bash`, SessionStart `compact`), `core/CLAUDE.md` (`# Compact instructions`), `core/skills/triaging-requests/SKILL.md` (final classify step), `core/skills/orchestrating-delivery/SKILL.md` (spec-adversary mandatory both modes).
