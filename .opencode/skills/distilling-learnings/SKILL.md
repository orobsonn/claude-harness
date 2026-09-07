---
name: oc-distilling-learnings
description: Reads the transient findings buffer, applies the durability test, then routes each durable insight by blast-radius to the right NATIVE destination — project pattern → native project-root MEMORY.md (durable index, one note = one concept), law of one folder → that folder's nested AGENTS.md (or its existing CLAUDE.md router) + root router row, global convention → kaizen.md proposal. No learnings store is written. Use when the harvester runs after recording-findings completes; never during active implementation.
license: MIT
compatibility: opencode
metadata:
  phase: harvest
  routes-to: MEMORY.md, nested AGENTS.md, kaizen.md
---

# Distilling-Learnings — Routing durable insights into the right native mechanism

**Announce at the start (in pt-br):** "Usando distilling-learnings para rotear os aprendizados duráveis dos findings pro mecanismo nativo certo."

**Input:** the current transient findings buffer (just consolidated by `oc-recording-findings`).

**There is no separate learnings store.** This skill does not create or append to any custom learnings file. Durable knowledge goes to the **native mechanism chosen by blast-radius** — the exact destinations `agents/harvester.md` step 4 routes to. A custom store would just duplicate the native `MEMORY.md` index + nested `AGENTS.md` law, so it is dropped.

This skill **owns** the classify-and-route machine below; `skill({ name: "oc-surveying-codebase" })` reuses it unchanged, sourcing insights from the code itself instead of a run's findings buffer.

---

## Pipeline

1. **Read the findings buffer** — scan all entries for the current feature run.
2. **Identify candidates** — a finding qualifies as durable if it is:
   - A pattern seen in 2+ tasks or explicitly flagged as systemic.
   - A helper/utility that was missing and had to be improvised.
   - An implicit convention that the plan did not document but was necessary.
   - An anti-pattern the adversary or sniper caught that could recur in future features.
3. **Cross-check against the codebase** — use Grep/Glob to confirm the pattern is real and not a one-off. A one-off bug fixed by a `sniper-<tier>` has no durable destination — it stays in git only (and the findings buffer is deleted at harvest end).
4. **Apply the durability test** (below) — drop anything that fails.
5. **Classify blast-radius and write to the native destination** (below) — one entry per durable insight.

---

## Durability test (apply before routing)

Ask: "Would this entry help a future executor avoid a mistake or make a better decision on a future unrelated run?"

- YES → route it (step: classify blast-radius).
- NO (one-off, context-specific, already in AGENTS.md/CLAUDE.md) → skip it. It lives in git only.

---

## Classify blast-radius → native destination

For each insight that passes the durability test, pick **one** destination by how far the knowledge applies. These match `agents/harvester.md` step 4 verbatim.

### A. Project pattern → native MEMORY.md
The insight is a reusable pattern/decision/anti-pattern that applies **across the whole project** (not bound to one folder). Add a concise indexed entry to the project's durable **`MEMORY.md`** (project root — the always-loaded, planner-visible index that `planner.md` §2 reads before decomposing):

- **One note = one concept** (atomic — if the title has "and", split into two entries).
- One index line per insight: `- [<short-kebab-title>](#<anchor>) — <one-clause recall hook: what it is and when it matters>`. The recall hook is what surfaces the note to the `planner` later — make it specific, never a run report.
- Under that note's anchor, body is exactly these two sections (no Claude memory-file frontmatter, no `metadata.type: project` block — `MEMORY.md` is one plain markdown index, not a directory of typed files):
  ```markdown
  **Why:** <the constraint / decision / failure mode that makes this durable>
  **How to apply:** <the concrete action a future executor takes — file/util/pattern to use or avoid>
  ```
- If `MEMORY.md` does not exist yet at the project root, create it with a `# MEMORY.md` heading and the first entry. (On a cold codebase, prefer `skill({ name: "oc-surveying-codebase" })` to populate it in bulk.) For this project, the legacy Claude memory still lives outside the tree — do **not** reach into it; the first harvest/survey seeds a fresh project-root `MEMORY.md`.

### B. Law of one folder → nested AGENTS.md (or existing CLAUDE.md router)
The insight is a rule that applies **only inside one folder/subsystem** (e.g. "all handlers under `src/auth/` must re-validate the JWT signature, not just presence"). Write it to that folder's nested **`AGENTS.md`** — or to the folder's existing **`CLAUDE.md`** if that file is already the folder's router (OpenCode reads project `CLAUDE.md`, root and nested, by up-traversal). Match the existing file's style.

- Append a concise convention/gotcha line under the appropriate heading.
- Add/refresh **one row** in the root router table (root `AGENTS.md` or root `CLAUDE.md`, whichever the project uses): `<folder> | <what lives there> | see <folder>/AGENTS.md`.
- `build` reads the nested folder file of a task's `scope_paths` deliberately and injects it as L3 — so this is the mechanism that gets a folder's law in front of the executor.

### C. Global convention → kaizen.md proposal (human-gated)
The insight is a **harness-wide-or-broader** convention that would change how the harness itself behaves across all projects (an agent, a skill, a global git/release rule). **Do not write it to any root rules file here** — hand it off so the proposal is logged, not applied:

- Invoke `skill({ name: "oc-proposing-improvements" })`, which owns the `kaizen.md` format and runs the precedent check before appending. The proposal lands as `Status: proposed` in the project-root `kaizen.md` and is **NEVER auto-applied** — a human reviews it.
- Do **not** edit root `AGENTS.md`, `~/.config/opencode/AGENTS.md`, or any rules file directly, and do **not** reach into `~/.claude`. There is no `paths:`-scoped rules mechanism in OpenCode — harness-wide changes are *proposed* to `kaizen.md`, never promoted into the global rules from this skill.

### D. One-off → git only
No durable destination. Do nothing — it already lives in the run's commit/PR.

---

## retire-on-promote

If an insight you would route to MEMORY.md (A) or a nested AGENTS.md (B) is actually being **promoted up** to a kaizen.md global convention (C), do not duplicate the content. Replace the original pointer with `promoted → <path>` so the same knowledge is not paid for in two places.

---

## Anti-patterns

- **Writing a custom learnings store** — there is none. Route to MEMORY.md / nested AGENTS.md / kaizen.md instead.
- **Reaching into `~/.claude/projects/<slug>/memory/`** — that is a Claude Code path and does NOT exist in this harness. The native project memory is the project-root `MEMORY.md`.
- **Wrong blast-radius** — a folder-specific rule dumped into project-wide MEMORY.md pollutes recall; a project pattern buried in one folder's AGENTS.md never surfaces for other tasks. Pick the tightest scope that still covers the insight.
- **Mirroring the findings buffer** — MEMORY.md is for durable extractions, not a run report. If an entry reads like "what happened this run", it is wrong.
- **One-off bugs as patterns** — a bug fixed by a `sniper-<tier>` in a single task is not durable unless the same class appears in 2+ tasks.
- **Editing root/global rules directly for a global convention** — never write a harness-wide rule into root `AGENTS.md` or `~/.config/opencode/AGENTS.md`; that is `oc-proposing-improvements`' job via a human-reviewed `kaizen.md` proposal.
- **Duplicating AGENTS.md/CLAUDE.md** — if the pattern is already documented, skip it (or, if promoting, leave a `promoted → <path>` pointer). Never restate it in MEMORY.md.
- **Vague entries** — "handle errors properly" is not durable. "Upstream bodies truncated to 500 chars before logging to prevent JWT leak — see `src/utils/errors.ts`" is.

---

## Cold codebase

If the project enters the harness with empty memory (no `MEMORY.md`, unfilled nested `AGENTS.md`) and there is no findings buffer to distill — i.e. durable knowledge must be mined from the **code itself**, not a run — that is not this skill's job. Hand off to `skill({ name: "oc-surveying-codebase" })`, which sources insights from the codebase and routes them through this exact same classify-and-route machine.
