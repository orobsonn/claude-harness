---
name: surveying-codebase
description: Surveys an onboarded project's codebase for durable, reusable knowledge (existing helpers to reuse, implicit conventions, architectural patterns, anti-patterns/gotchas), applies the durability test, and routes each insight by blast-radius to the right NATIVE destination — the same routing as distilling-learnings, but sourced from the code itself, not a run's findings buffer. Use when a legacy/existing project enters the harness with empty memory (no/empty MEMORY.md + unfilled nested AGENTS.md), or when build's Phase 0 finds the memory cold; one-time / on-demand, re-run when the codebase changes substantially. No learnings store is written.
license: MIT
compatibility: opencode
metadata:
  phase: onboarding
  routes-to: MEMORY.md, nested AGENTS.md, kaizen.md
---

# Surveying-Codebase — Cold-start the memory of an onboarded project

**Announce at the start (in pt-br):** "Usando surveying-codebase para popular a memória do projeto a partir da própria codebase."

**Input:** the codebase of the project being onboarded — no run, no findings buffer.

**This is the cold-start twin of `distilling-learnings`.** Both route durable knowledge by blast-radius into the native memory model (project-root `MEMORY.md` / nested `AGENTS.md`-or-`CLAUDE.md` / `kaizen.md`). The ONLY difference is the SOURCE: distilling reads a run's transient findings buffer; surveying reads the **codebase itself**. The routing machine — durability test, blast-radius classes, destinations, retire-on-promote — is identical and is **reused, never re-implemented**: invoke `skill({ name: "distilling-learnings" })` to read the full routing rules. There is no separate learnings store.

---

## When to use

- A legacy/existing project enters the harness with no accumulated memory.
- `build`'s **Phase 0** reads the native durable index (project-root `MEMORY.md`, root `AGENTS.md`/`CLAUDE.md` router) and finds the memory cold/empty on a non-trivial project.
- Manually requested by the operator.
- **Re-run** when the codebase changes substantially (new subsystem, big refactor).

**One-time / on-demand — not a per-run step.** When NOT to use: a fresh/empty project (nothing durable to extract yet) → just set up the structure (root router table + nested folder stubs); there is nothing to survey.

---

## Pipeline

1. **Confirm structure + locate the project root** — the root router table (in the project's root `AGENTS.md` or root `CLAUDE.md`) and nested `AGENTS.md` stubs should exist. If a folder you route to has no nested file yet, seed the stub for that folder as you route to it (the way the `harvester` does). The native project memory is the project-root `MEMORY.md` — if it does not exist yet (a project may still carry only a legacy Claude memory dir under `~/.claude/projects/.../memory/`, which this harness does NOT read), create `MEMORY.md` at the project root with a `# MEMORY.md` heading on first write.
2. **Map the structure** — top-level subsystems (domain folders under `src/` or the code root) and each one's key modules. This is **orientation, not output** — never emit a file inventory.
3. **Extract durable-knowledge candidates** — read specifically for:
   - **Existing helpers/utils** a future executor would otherwise reinvent (e.g. `src/utils/errors.ts` already sanitizes upstream bodies — reuse it, don't rebuild it).
   - **Implicit conventions** the code follows but no doc states (naming, error handling, layering, where validation happens).
   - **Architectural patterns** — how requests flow, where state lives, the seam between layers.
   - **Anti-patterns / gotchas** baked into the code — a workaround, a footgun, a load-bearing quirk.
4. **Apply the durability test** (reused) — "Would this help a future executor avoid a mistake or make a better decision?" NO → drop it; it lives in the code/git only.
5. **Classify blast-radius and route to the native destination** (reused — table below).

---

## Routing (reused from distilling-learnings)

Per durable insight, pick **one** destination by how far it applies. **The full rules — the MEMORY.md index-line shape, the `Why:`/`How to apply:` body, the root-router row, retire-on-promote — are owned by `distilling-learnings`. Load that skill (`skill({ name: "distilling-learnings" })`) and follow it; do not restate or fork its logic here.**

| Blast-radius | Native destination |
|---|---|
| **Project pattern** (whole project) | a one-line indexed entry in the project-root `MEMORY.md` (one note = one concept) |
| **Law of one folder** (one subsystem) | that folder's nested `AGENTS.md` (or its existing `CLAUDE.md` router — fill the stub) + one row in the root router table |
| **Global convention** (harness-wide or broader) | a `kaizen.md` proposal (`Status: proposed`) — human-gated; do NOT edit the root rules directly. Hand off to `skill({ name: "proposing-improvements" })`. |
| **One-off** | nothing — it lives in the code/git |

Pick the **tightest scope that still covers the insight**.

---

## Anti-patterns

- **Code dump / file inventory** — surveying outputs durable, reusable, non-obvious KNOWLEDGE, not "here are the files". A list of folders is not memory.
- **Re-implementing the routing** — the durability test + blast-radius classes + destinations belong to `distilling-learnings`. Reference it; don't fork it.
- **Reaching into `~/.claude`** — no `~/.claude/projects/<slug>/memory/` path exists here. Native project memory is the project-root `MEMORY.md`; the harness is self-contained.
- **Obvious / framework knowledge** — "uses React", "has a `package.json`" helps no one. Only what a careful reader would otherwise miss.
- **Wrong blast-radius** — a folder rule in project-wide memory pollutes recall; a project pattern buried in one folder's file never surfaces for other tasks.
- **Inventing law** — record only conventions the code actually follows. Do not prescribe what you wish were true.

---

## Self-check before done

- Every entry passes the durability test (helps a future executor decide/avoid).
- Each routed to exactly one native destination by blast-radius; no separate learnings store written.
- No file inventory or framework-obvious noise emitted.
- `MEMORY.md` index lines and root router rows added for what was written.
- Report to the operator (pt-br, product-language) what was populated — never code-language.
