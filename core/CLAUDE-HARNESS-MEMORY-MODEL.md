# Claude Harness — Memory Model

The single source of truth for how the harness stores and routes knowledge. Referenced by
`harvester`, `distilling-learnings`, and `surveying-codebase`. **Repo-committed first:** every
durable destination lives inside the repo's `.claude/` so cloud routines see and persist it — there
is **no `learnings.md`** custom store. Never write secrets/PII into any committed memory/kaizen file.

---

## The three tiers

### N1 — ephemeral (run buffers, deleted at harvest end)
- `shared_context.md` (`.claude/plans/<feature_id>/shared_context.md`) — task-to-task carry-forward.
- `findings.md` (project root) — raw run digest, input to `distilling-learnings`.

Both are deleted by the harvester at the end of the run. The **durable audit is git** (the run's
commit/PR), which the git rule already defines as the source of truth. Never treat these as a
cross-run archive.

### N2 — durable index (repo-committed, planner reads it explicitly)
- `.claude/memory/MEMORY.md` — one-line index of durable project patterns/anti-patterns. Read it
  with an explicit `Read` (do not rely on native auto-load — not guaranteed in cloud routines).
- root `CLAUDE.md` router table ("folder → what lives there → see `<folder>/CLAUDE.md`").

### N3 — curated / authoritative (the durable prose, routed by blast-radius)
- **project pattern** → repo memory file in `.claude/memory/<name>.md` (frontmatter
  `name` / `description` / `metadata.type`, body with **Why:** / **How to apply:**) + one index
  line in `.claude/memory/MEMORY.md`.
- **law of one folder** → that folder's nested `CLAUDE.md` (e.g. `src/auth/CLAUDE.md`) + one row
  in the root `CLAUDE.md` router table.
- **global convention** → `.claude/kaizen.md` proposal (committed outbox), human-reviewed before
  promotion to the framework source (`core/`). Never auto-applied.
- **one-off** → stays in git only (dies with `findings.md`).

---

## Routing rule (blast-radius)

Ask: *where is this knowledge true?*

| Scope of truth | Destination |
|---|---|
| This project, across folders | repo memory (`.claude/memory/MEMORY.md` + memory file) |
| Exactly one folder/subsystem | that folder's nested `CLAUDE.md` |
| Every project (global convention) | `.claude/kaizen.md` proposal (human-gated) |
| Only this run | git only — do not persist |

## Durability test

Persist an insight only if it is **reusable** (will inform a future task) and **non-obvious**
(not derivable from the code, git history, or existing CLAUDE.md). Otherwise it stays in git.

## retire-on-promote

When a learning that already lived in repo memory or a folder index is promoted up to a
`CLAUDE.md` / rule, turn the original pointer into `promoted → <path>` so the same content is
never paid for twice.

---

## Two entry points, one routing machine

The routing machine above (durability test → blast-radius classes → destinations → retire-on-promote)
is **identical** for both producers; only the SOURCE differs:

- `distilling-learnings` — reads a run's transient `findings.md` (post-delivery).
- `surveying-codebase` — reads the **codebase itself** (cold-start, when `.claude/memory/MEMORY.md`
  and the nested `CLAUDE.md` files are empty).

Neither re-implements the machine — they share it.
