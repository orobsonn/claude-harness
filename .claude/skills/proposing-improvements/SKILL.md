---
name: proposing-improvements
description: "Scans the transient findings.md for systemic patterns that indicate an agent or skill in the harness could be improved, and appends proposals (never auto-applies them) to kaizen.md. Because findings.md is deleted at harvest end, kaizen.md is the durable cross-run signal — check it for precedent. Use when the harvester runs after distilling-learnings completes."
---

# Proposing-Improvements — Logging harness improvement proposals to kaizen.md

**Announce at the start (in pt-br):** "Usando proposing-improvements para detectar padrões sistêmicos e propor melhorias ao harness em kaizen.md."

**Input:** the current transient `findings.md` (written by `recording-findings`, deleted at harvest end) plus the durable `kaizen.md` (cross-run memory). Since `findings.md` does not survive the run, `kaizen.md` is where cross-run precedent lives — a second occurrence of a signal is detected by matching against existing `kaizen.md` entries, not against an old `findings.md`.

---

## GOLDEN RULE — read this first

**This skill NEVER edits agents or skills in `~/.claude/agents/` or `~/.claude/skills/`.** It only appends proposals to `kaizen.md`. The human reads `kaizen.md` periodically and decides what to apply. Auto-applying would cause unreviewed drift in the harness itself — that is the failure mode this rule prevents.

---

## Pipeline

1. **Read findings.md** — scan all entries for the current feature run.
2. **Detect systemic signals** — a finding is systemic if it matches one or more of:
   - Same **category** of issue appears in 2+ separate tasks (e.g., two adversary `edge-case` findings on different tasks).
   - Same `NEEDS_CONTEXT` key requested by executor across 2+ tasks (missing resolved_judgment type).
   - Compliance or adversary repeatedly flagging the same global-rule violation.
   - A structural friction point: the loop stalled, needed extra rounds, or a gate fired unexpectedly due to a harness gap (not implementation gap).
3. **One-off check** — if the signal appears in only one task this run and has no precedent in `kaizen.md`, do not propose. Because `findings.md` is deleted at harvest end, **`kaizen.md` is the only cross-run record** — check it for a prior occurrence of the same signal. A one-off with no kaizen precedent is left in git only (it dies with `findings.md`).
4. **Write one proposal per systemic signal** to `kaizen.md` (append, never overwrite).

---

## kaizen.md structure

```markdown
# kaizen.md

## YYYY-MM-DD — <feature-name>

### <proposal title>
**Symptom:** <what was observed in findings, with task IDs>
**Affected agent/skill:** <e.g., executor, adversary, creating-plans, recording-findings>
**Suggested change:** <concrete description of the improvement — what to add, remove, or reword>
**Status:** proposed
```

Mark **Status: proposed** always. The human changes it to `accepted`, `rejected`, or `deferred`.

---

## Anti-patterns

- **One-off proposals** — a single bug in a single task is not a harness problem. Keep it in findings.md.
- **Vague proposals** — "improve adversary" is not actionable. "Add `open-redirect` to adversary's universal attack categories since it was missed in two separate URL-handling tasks" is.
- **Self-referential proposals** — do not propose changes to `recording-findings`, `distilling-learnings`, or `proposing-improvements` based on a single run. Wait for a second data point.
- **Auto-editing harness files** — never touch `~/.claude/agents/` or `~/.claude/skills/` directly, regardless of how clear the fix seems.
