---
name: oc-recording-findings
description: Consolidates executor, compliance, adversary, and sniper finding blocks from a completed feature run into the transient findings buffer at the project root. The findings buffer is ephemeral — the input to distilling-learnings, deleted by the harvester at the end of the run; durable audit lives in git. Use when the harvester runs after final review — never during active implementation.
license: MIT
compatibility: opencode
metadata:
  phase: harvest
  buffer: findings
---

# Recording-Findings — Consolidating agent outputs into the transient findings buffer

**Announce at the start (in pt-br):** "Usando recording-findings para consolidar os findings da run no buffer de findings."

**Input:** the raw output blocks emitted by `executor-<tier>`, `compliance`, `adversary`, and `sniper-<tier>` agents during the completed feature run (the run's findings buffer that `build` accumulated in Phase 2 step h).

**The findings buffer is TRANSIENT** — a single-run digest. It is the input to `oc-distilling-learnings` (which routes durable insights to native MEMORY.md / nested AGENTS.md / kaizen.md) and is then **deleted by the harvester** at the end of the run (per `agents/harvester.md` step 5). It is not a durable archive — the run's commit/PR in git is the durable audit. Do not treat it as a cross-run log.

---

## Finding block formats (per agent)

The tiered agents (`executor-high/medium/low`, `sniper-high/medium/low`) emit under the same headings regardless of tier — match on the heading, not the tier suffix.

**Executor** (`executor-<tier>`) emits under `### Findings`:
```
- <decision taken, gotcha hit, or assumption made>
```

**Compliance** emits under `### Problemas encontrados`:
```
- PROBLEMA: <description> — file:line
- SUGESTAO: <non-blocking improvement>
```

**Adversary** emits a JSON `issues` array:
```json
{ "description": "...", "category": "...", "severity": "low|medium|high", "scope": "...", "evidence": "...", "fix_hint": "..." }
```

**Sniper** (`sniper-<tier>`) emits under `### Findings`:
```
- <side-effect observed, adjacent issue spotted (not fixed)>
```

---

## Consolidation rules

1. Group by **task ID** (from the execution-plan in `planner.md`'s schema), then by **phase** (executor → compliance → adversary → sniper).
2. Within a task, deduplicate: if the same issue appears in both compliance and adversary output, keep one entry and note both sources.
3. Normalize adversary JSON issues into prose lines matching the findings format (include severity tag).
4. Keep each line **concise** — one line per finding unless the evidence quote is load-bearing.
5. Append-only **within this run**: never delete entries from the current run, only add. There is no prior-run content to preserve — the findings buffer covers a single run and is deleted at harvest end.

---

## findings buffer structure

```markdown
# findings

## [feature-id] — YYYY-MM-DD

### task-id: <task id from execution-plan>
**Decisions taken**
- <decision>

**Gotchas**
- <gotcha — include file:line if relevant>

**Bugs found + resolved**
- [severity] <description> — <source: adversary|compliance|sniper> — RESOLVED

**Bugs found + unresolved**
- [severity] <description> — <source> — OPEN

**Assumptions**
- <assumption made by executor>
```

If a task produced no notable findings in a category, omit that subsection entirely.

---

## Anti-patterns

- **Copying full agent output verbatim** — the findings buffer is a digest, not a log. Distill.
- **Mixing unresolved and resolved bugs without tagging** — always mark RESOLVED or OPEN.
- **Skipping tasks with DONE status** — even clean tasks may have assumptions worth recording.
- **Reaching into `~/.claude`** — this harness is self-contained; the buffer lives at the project root, consumed by `oc-distilling-learnings` and deleted by `harvester`.
