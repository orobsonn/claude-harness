---
name: proposing-improvements
description: "Scans the transient findings buffer for systemic patterns that indicate a harness agent or skill could be improved, and appends proposals (never auto-applies them) to the project-root kaizen.md. Because the findings buffer is deleted at harvest end, kaizen.md is the durable cross-run signal — check it for precedent. Use when the harvester runs after distilling-learnings completes; never during active implementation."
license: MIT
compatibility: opencode
metadata:
  phase: harvest
  routes-to: kaizen.md
---

# Proposing-Improvements — Logging harness improvement proposals to kaizen.md

**Announce at the start (in pt-br):** "Usando proposing-improvements para detectar padrões sistêmicos e propor melhorias ao harness em kaizen.md."

**When you run:** at harvest time, AFTER the final dual review passes and AFTER `skill({ name: "distilling-learnings" })` has routed durable learnings. This is the harvester's last knowledge step (`build.md` Phase 5). Never during active implementation.

**Input:** the current transient findings buffer (consolidated by `skill({ name: "recording-findings" })`, deleted by the harvester at the end of the run) plus the durable **`kaizen.md`** at the project root (cross-run memory). Since the findings buffer does not survive the run, `kaizen.md` is where cross-run precedent lives — a second occurrence of a signal is detected by matching against existing `kaizen.md` entries, not against an old findings buffer.

---

## GOLDEN RULE — read this first

**This skill NEVER edits a harness agent or skill.** It does not touch `~/.config/opencode/agents/<name>.md`, `~/.config/opencode/skills/<name>/SKILL.md`, or `~/.config/opencode/AGENTS.md`. It only **appends proposals** to the project-root `kaizen.md`. The human reads `kaizen.md` periodically and decides what to apply. Auto-applying would cause unreviewed drift in the harness itself — that is the failure mode this rule prevents.

This is the same contract `agents/harvester.md` step 4 declares for global conventions: "append a proposal to kaizen.md. NEVER auto-apply — a human reviews kaizen proposals. Check kaizen.md for precedent first."

---

## Pipeline

1. **Read the findings buffer** — scan all blocks for the current feature run (compliance, adversary, security, sniper).
2. **Detect systemic signals** — a finding is systemic if it matches one or more of:
   - Same **category** of issue appears in 2+ separate tasks (e.g., two adversary `boundary` findings on different tasks).
   - Same `NEEDS_CONTEXT` key requested by an executor across 2+ tasks (a missing `resolved_judgment` type the planner keeps under-specifying).
   - `compliance` or `adversary` repeatedly flagging the same global-rule violation (an `AGENTS.md` rule agents keep tripping on).
   - A **structural friction point**: the loop stalled, needed extra rounds, a tier bump fired, or a gate fired unexpectedly because of a harness gap (not an implementation gap).
3. **One-off check** — if the signal appears in only one task this run and has **no precedent in `kaizen.md`**, do not propose. Because the findings buffer is deleted at harvest end, **`kaizen.md` is the only cross-run record** — read it once and check for a prior occurrence of the same signal. A one-off with no kaizen precedent is left in git only (it dies with the findings buffer). A one-off that DOES match an existing kaizen entry is now the second data point — propose, unless a proposal for it already exists (then do not duplicate it).
4. **Write one proposal per systemic signal** to `kaizen.md` (append, never overwrite). One signal = one proposal.

---

## kaizen.md — location and structure

`kaizen.md` lives at the **project root** (`<project>/kaizen.md`), append-only. It is the single harness-improvement proposal store, consistent with `agents/harvester.md`. Do NOT write proposals into `~/.config/opencode/AGENTS.md`, into a nested `AGENTS.md`, or into any agent/skill file — those are *applied* changes, and applying is the human's job after reviewing the proposal.

Append a block per proposal:

```markdown
## YYYY-MM-DD — <feature-name>

### <proposal title>
**Symptom:** <what was observed in the findings buffer, with task IDs>
**Affected agent/skill:** <exact native name — see allowed values below>
**Suggested change:** <concrete description of the improvement — what to add, remove, or reword>
**Status:** proposed
```

Mark **Status: proposed** always. The human changes it to `accepted`, `rejected`, or `deferred`.

**Affected agent/skill — allowed values (exact native names only):**
- Agents: `build`, `planner`, `plan-reviewer`, `executor-high`, `executor-medium`, `executor-low`, `compliance`, `adversary`, `security`, `sniper-high`, `sniper-medium`, `sniper-low`, `harvester`, `shipper`.
- Skills: `committing-changes`, `releasing-versions`, `recording-findings`, `distilling-learnings`, `proposing-improvements`, `surveying-codebase`, `authoring-rules`, `deploying-workers`, etc.
- Global rule file: `AGENTS.md` (a rule that should change across all projects — proposed here, never edited directly).

**Forbidden as affected-agent values:**
- Bare `executor` or `sniper` — there is NO untiered executor/sniper; always name the tier (`executor-high`, `sniper-low`, …) or the role family if the proposal is tier-agnostic ("all `executor-*` tiers").
- Claude model slugs (`haiku`/`sonnet`/`opus`) — the harness has no tiers by those names; reference the agent name.
- Claude orchestration skill names (`triaging-requests`, `orchestrating-delivery`, `creating-plans`) — they do not exist natively; that logic lives in `build` and `planner`. A proposal about triage/orchestration/planning routes to `build` or `planner`.

**Check `kaizen.md` for precedent before appending** — if a near-identical proposal already exists, do not duplicate it; a second occurrence is evidence the existing proposal should be promoted in the human's review, not a fresh entry.

---

## Anti-patterns

- **One-off proposals** — a single bug in a single task is not a harness problem. It dies with the findings buffer; git holds the audit. Do not propose it unless `kaizen.md` already shows a prior occurrence.
- **Vague proposals** — "improve adversary" is not actionable. "Add `open-redirect` to `adversary`'s universal attack categories since it was missed in two separate URL-handling tasks (t3, t7)" is.
- **Self-referential single-run proposals** — do not propose changes to `recording-findings`, `distilling-learnings`, or `proposing-improvements` based on a single run. Wait for a second data point.
- **Auto-editing harness files** — never touch `~/.config/opencode/agents/<name>.md`, `~/.config/opencode/skills/<name>/SKILL.md`, or `~/.config/opencode/AGENTS.md` directly, regardless of how clear the fix seems. Append to `kaizen.md` only; the human applies it.
