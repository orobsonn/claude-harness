---
name: distilling-learnings
description: "Reads the transient findings.md, applies the durability test, then routes each durable insight by blast-radius to the right repo-committed destination — project pattern → repo memory (.claude/memory/<name>.md + .claude/memory/MEMORY.md index), law of one folder → that folder's nested CLAUDE.md + root router row, global convention → .claude/kaizen.md proposal. No learnings.md is written. Use when the harvester runs after recording-findings completes; never during active implementation."
---

# Distilling-Learnings — Routing durable insights into the right native mechanism

**Announce at the start (in pt-br):** "Usando distilling-learnings para rotear os aprendizados duráveis dos findings pro mecanismo nativo certo."

**Input:** the current transient `findings.md` (just written by `recording-findings`).

**There is no `learnings.md`.** This skill does not create or append to any custom learnings store. Durable knowledge goes to the **repo-committed destination chosen by blast-radius** (see the memory model in `CLAUDE-HARNESS-MEMORY-MODEL.md`). The custom `learnings.md` was dropped because the `.claude/memory/MEMORY.md` index + nested `CLAUDE.md` already cover the planner-visible index and the per-folder law — a custom store would just triplicate them.

---

## Pipeline

1. **Read findings.md** — scan all entries for the current feature run.
2. **Identify candidates** — a finding qualifies as durable if it is:
   - A pattern seen in 2+ tasks or explicitly flagged as systemic.
   - A helper/utility that was missing and had to be improvised.
   - An implicit convention that the plan did not document but was necessary.
   - An anti-pattern the adversary or sniper caught that could recur in future features.
3. **Cross-check against the codebase** — use Grep/Glob to confirm the pattern is real and not a one-off. A one-off bug fixed by the sniper has no durable destination — it stays in git only (and `findings.md` is deleted at harvest end).
4. **Apply the durability test** (below) — drop anything that fails.
5. **Classify blast-radius and write to the native destination** (below) — one entry per durable insight.

---

## Durability test (apply before routing)

Ask: "Would this entry help a future executor avoid a mistake or make a better decision?"

- YES → route it (step: classify blast-radius).
- NO (one-off, context-specific, already in CLAUDE.md/rules) → skip it. It lives in git only.

---

## Classify blast-radius → native destination

For each insight that passes the durability test, pick **one** destination by how far the knowledge applies:

### A. Project pattern → repo memory
The insight is a reusable pattern/decision/anti-pattern that applies **across the whole project** (not bound to one folder). Write a **repo memory file** under `.claude/memory/` (committed — never write secrets/PII):

- One file per insight (atomic — if the title has "and", split).
- Frontmatter:
  ```yaml
  ---
  name: <short-kebab-or-title>
  description: <one-line recall hook — what it is and when it matters; this is what surfaces it later>
  metadata:
    type: project
  ---
  ```
- Body, exactly these two sections:
  ```markdown
  **Why:** <the constraint / decision / failure mode that makes this durable>
  **How to apply:** <concrete action a future executor takes — file/util/pattern to use or avoid>
  ```
- Add **one index line** to `.claude/memory/MEMORY.md` (the planner reads it explicitly). One line per file — `[<name>](<file>.md) — <one-clause summary>`.

### B. Law of one folder → nested CLAUDE.md
The insight is a rule that applies **only inside one folder/subsystem** (e.g. "all handlers under `src/auth/` must re-validate the JWT signature, not just presence"). Write it to that folder's nested `CLAUDE.md` (e.g. `src/auth/CLAUDE.md`):

- Append a concise convention/gotcha line under the appropriate heading; follow the existing style of that file.
- Add/refresh **one row** in the root `CLAUDE.md` router table: `<folder> | <what lives there> | see <folder>/CLAUDE.md`.
- The orchestrator reads the nested `CLAUDE.md` of a task's folder deliberately and injects it (L3) — so this is the mechanism that gets a folder's law in front of the executor.

### C. Global convention → kaizen proposal (human-gated)
The insight is a **project-wide-or-broader** convention that belongs in the root `CLAUDE.md` or a rule with `paths:`. **Do not write it directly here** — flag it so `proposing-improvements` logs a kaizen proposal. Promotion to root `CLAUDE.md` / rules is always human-reviewed.

### D. One-off → git only
No durable destination. Do nothing — it already lives in the run's commit/PR.

---

## retire-on-promote

If an insight you would route to repo memory (A) or a nested `CLAUDE.md` (B) is actually being **promoted up** to the root `CLAUDE.md` / a rule (C), do not duplicate the content. Replace the original pointer with `promoted → <path>` so the same knowledge is not paid for in two places.

---

## Anti-patterns

- **Writing a `learnings.md`** — it does not exist anymore. Route to repo memory / nested `CLAUDE.md` / kaizen instead.
- **Wrong blast-radius** — a folder-specific rule dumped into project-wide repo memory pollutes recall; a project pattern buried in one folder's `CLAUDE.md` never surfaces for other tasks. Pick the tightest scope that still covers the insight.
- **Mirroring findings.md** — repo memory is for durable extractions, not a run report. If an entry reads like "what happened this run", it is wrong.
- **One-off bugs as patterns** — a bug fixed by sniper in a single task is not durable unless the same class appears in 2+ tasks.
- **Duplicating CLAUDE.md/rules** — if the pattern is already documented, skip it (or, if promoting, leave a `promoted → <path>` pointer). Never restate it in repo memory.
- **Vague entries** — "handle errors properly" is not durable. "Upstream bodies truncated to 500 chars before logging to prevent JWT leak — see `src/utils/errors.ts`" is.
