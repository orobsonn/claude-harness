---
name: recording-findings
description: "Consolidates executor, compliance, adversary, and sniper finding blocks from a completed feature run into the transient findings.md buffer at the project root. findings.md is ephemeral — the input to distilling-learnings, deleted by the harvester at the end of the run; durable audit lives in git. Use when the harvester agent runs after final dual review — never during active implementation."
---

# Recording-Findings — Consolidating agent outputs into the transient findings.md

**Announce at the start (in pt-br):** "Usando recording-findings para consolidar os findings da run em findings.md."

**Input:** the raw output blocks emitted by executor, compliance, adversary, security, and sniper agents during the completed feature run.

**`findings.md` is TRANSIENT** — a single-run digest. It is the input to `distilling-learnings` (which routes durable insights to native memory / nested `CLAUDE.md` / kaizen) and is then **deleted by the harvester** at the end of the run. It is not a durable archive — the run's commit/PR in git is the durable audit. Do not treat it as a cross-run log.

---

## Finding block formats (per agent)

**Executor** emits under `### Findings`:
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

**Security** emits a `SECURE | UNSAFE` verdict plus a JSON `issues` array in the **same shape as the adversary's** (add `category: "security"` when normalizing):
```json
{ "description": "...", "category": "security", "severity": "low|medium|high", "scope": "...", "evidence": "...", "fix_hint": "..." }
```

**Sniper** emits under `### Findings`:
```
- <side-effect observed, adjacent issue spotted (not fixed)>
```

---

## Consolidation rules

1. Group by **task ID**, then by **phase** (executor → compliance → adversary → security → sniper).
2. Within a task, deduplicate: if the same issue appears in both compliance and adversary output, keep one entry and note both sources.
3. Normalize adversary JSON issues into prose lines matching the findings format (include severity tag).
4. Keep each line **concise** — one line per finding unless the evidence quote is load-bearing.
5. Append-only **within this run**: never delete entries from the current run, only add. There is no prior-run content to preserve — `findings.md` covers a single run and is deleted at harvest end.

---

## findings.md structure

```markdown
# findings.md

## [feature-name] — YYYY-MM-DD

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

- **Copying full agent output verbatim** — findings.md is a digest, not a log. Distill.
- **Mixing unresolved and resolved bugs without tagging** — always mark RESOLVED or OPEN.
- **Skipping tasks with DONE status** — even clean tasks may have assumptions worth recording.
