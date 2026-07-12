---
name: surveying-codebase
description: "Surveys an onboarded project's codebase for durable, reusable knowledge (existing helpers to reuse, implicit conventions, architectural patterns, anti-patterns/gotchas), applies the durability test, and routes each insight by blast-radius to the right repo-committed destination — the same routing as distilling-learnings, but sourced from the code itself, not a run's findings.md. Use when a legacy/existing project enters the harness with empty memory (.claude/memory/MEMORY.md + unfilled nested CLAUDE.md), via /surveying-codebase or when orchestrating-delivery Phase 0 finds the memory cold; one-time / on-demand, re-run when the codebase changes substantially. No learnings.md is written."
---

# Surveying-Codebase — Cold-start the memory of an onboarded project

**Announce at the start (in pt-br):** "Usando surveying-codebase para popular a memória do projeto a partir da própria codebase."

**Input:** the codebase of the project being onboarded — no run, no `findings.md`.

**This is the cold-start twin of `distilling-learnings`.** Both route durable knowledge by blast-radius into the repo-committed memory model (see `CLAUDE-HARNESS-MEMORY-MODEL.md`). The ONLY difference is the SOURCE: distilling reads a run's transient `findings.md`; surveying reads the **codebase itself**. The routing machine — durability test, blast-radius classes, destinations, retire-on-promote — is identical and is **reused, never re-implemented**. There is no `learnings.md`.

Pairs with `initializing-projects`: init creates the STRUCTURE (nested `CLAUDE.md` stubs + root router table); surveying fills the CONTENT.

---

## When to use

- A legacy/existing project enters the harness with no accumulated memory.
- `orchestrating-delivery` Phase 0 finds `.claude/memory/MEMORY.md` and nested `CLAUDE.md` empty on a non-trivial project.
- Manually via `/surveying-codebase`.
- **Re-run** when the codebase changes substantially (new subsystem, big refactor).

**One-time / on-demand — not a per-run step.** When NOT to use: a fresh/empty project (nothing durable to extract yet) → just run `initializing-projects`.

---

## Pipeline

1. **Confirm structure** — the root router table and nested `CLAUDE.md` stubs should already be seeded by `initializing-projects`. If missing, run `initializing-projects` first (or seed the stub for a folder as you route to it, the way the harvester does). Durable memory is the repo-committed `.claude/memory/` — no slug to resolve.
2. **Detect stack on cold entry** — on first onboarding of a legacy/existing project, run `detect-stack` (at `core/skills/initializing-projects/references/detect-stack.mjs`) to identify the project's test/check command (node-test, vitest, jest, or custom). This **detection-only** step surfaces the runner choice so memory population can reference the actual test flow. **CI generation itself stays owned by `initializing-projects` — do not claim to generate `ci.yml` in the survey.** The survey surfaces the detection; the init skill decides whether to scaffold CI.
3. **Map the structure** — top-level subsystems (domain folders under `src/` or the code root) and each one's key modules. This is **orientation, not output** — never emit a file inventory.
4. **Extract durable-knowledge candidates** — read specifically for:
   - **Existing helpers/utils** a future executor would otherwise reinvent (e.g. `src/utils/errors.ts` already sanitizes upstream bodies — reuse it, don't rebuild it).
   - **Implicit conventions** the code follows but no doc states (naming, error handling, layering, where validation happens).
   - **Architectural patterns** — how requests flow, where state lives, the seam between layers.
   - **Anti-patterns / gotchas** baked into the code — a workaround, a footgun, a load-bearing quirk.
5. **Apply the durability test** (reused) — "Would this help a future executor avoid a mistake or make a better decision?" NO → drop it; it lives in the code/git only.
6. **Classify blast-radius and route to the native destination** (reused — table below).

---

## Routing (reused from distilling-learnings)

Per durable insight, pick **one** destination by how far it applies. **Full rules — frontmatter shape, `Why:`/`How to apply:` body, `MEMORY.md` index line, retire-on-promote — are owned by `distilling-learnings`. Follow that skill; do not restate or fork its logic here.**

| Blast-radius | Repo-committed destination |
|---|---|
| **Project pattern** (whole project) | repo memory file under `.claude/memory/` (`type: project`) + one index line in `.claude/memory/MEMORY.md` |
| **Law of one folder** (one subsystem) | that folder's nested `CLAUDE.md` (fill the init stub) + one row in the root `CLAUDE.md` router table |
| **Global convention** (project-wide or broader) | a `.claude/kaizen.md` proposal (`Status: proposed`) — human-gated; do NOT write the root `CLAUDE.md` directly |
| **One-off** | nothing — it lives in the code/git |

Pick the **tightest scope that still covers the insight**.

---

## Anti-patterns

- **Code dump / file inventory** — surveying outputs durable, reusable, non-obvious KNOWLEDGE, not "here are the files". A list of folders is not memory.
- **Re-implementing the routing** — durability test + blast-radius classes + destinations belong to `distilling-learnings`. Reference it; don't fork it.
- **Creating a `learnings.md`** — it does not exist. Route to repo memory / nested `CLAUDE.md` / kaizen.
- **Obvious / framework knowledge** — "uses React", "has a `package.json`" helps no one. Only what a careful reader would otherwise miss.
- **Wrong blast-radius** — a folder rule in project-wide memory pollutes recall; a project pattern buried in one folder's `CLAUDE.md` never surfaces for other tasks.
- **Inventing law** — record only conventions the code actually follows. Do not prescribe what you wish were true.

---

## Self-check before done

- Every entry passes the durability test (helps a future executor decide/avoid).
- Each routed to exactly one repo-committed destination by blast-radius; no `learnings.md` written.
- No file inventory or framework-obvious noise emitted.
- `MEMORY.md` index lines and root router rows added for what was written.
- Report to the operator (pt-br, product-language) what was populated — never code-language.
