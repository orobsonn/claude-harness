---
name: oc-importing-claude-memory
description: "One-shot, OPERATOR-INVOKED migration that imports a repo's legacy Claude Code native memory (~/.claude/projects/<slug>/memory/) into this OpenCode harness's project-root MEMORY.md. The SINGLE sanctioned exception to the never-read-~/.claude rule — read-only, scoped to projects/<slug>/memory/ only, NEVER auto-run in the delivery loop, NEVER invoked by surveying-codebase or build. Run it by hand once when onboarding a repo that previously used Claude Code. Run the LLM-aided classification on a STRONG model (e.g. openai/gpt-5.5) — one-shot + security-critical, so the cheap open-source default is the wrong tradeoff here."
license: MIT
compatibility: opencode
metadata:
  phase: onboarding
  invocation: operator-only
  hermetic-exception: true
---

# Importing-Claude-Memory — one-shot migration of CC native memory into OC

A repo that previously used Claude Code accumulated a native per-project memory at `~/.claude/projects/<slug>/memory/` (a directory of one-fact-per-file notes + a `MEMORY.md` index). The OpenCode harness can't see it (hermetic rule), and it holds operator/decisional knowledge **not derivable from code or the project `CLAUDE.md`**. This skill migrates the durable, non-sensitive subset into the OC project-root `MEMORY.md`, **once**, by hand.

## Identity & boundary (non-negotiable)

- **Operator-invoked only.** Never auto-run. `oc-surveying-codebase`, `build`, and the delivery loop NEVER invoke this. The hermetic rule ("never read `~/.claude`") stays literally true for everything else — this is the one named exception, and it only fires when the human explicitly runs it.
- **Read-only on `~/.claude`, scoped to `projects/<slug>/memory/` only.** Never read any other `~/.claude` path. **Never write to `~/.claude`** (no "mark as imported" on the CC side — Finding 7). Enforce "once" with an OC-side marker only (below).

## Model — run the classification on a STRONG model

This skill runs **once per repo** and its hardest step (judging sensitivity + staleness of foreign notes) is exactly where a cheap open-source model fails open. So do NOT run the classification on the default hands. Use a **strong model — `openai/gpt-5.5`** (or the strongest available). The one-shot cost is negligible against the stakes (a leaked secret or a stale "fact" misguiding the planner).

How: either (a) switch the session/primary model to `openai/gpt-5.5` for this manual run, or (b) `build` dispatches the read+classify+secret-reasoning step to a `openai/gpt-5.5` subagent and keeps the **human-confirm** and **write** steps in `build` (primary) — the operator interaction must stay in primary. Either way, the deterministic `secret-scan` HARD-GATE still runs independently of the model — the strong model is an aid, never the gate.

## HARD-GATES (abort the import if any fails)

<HARD-GATE name="slug-confirm">
Derive the repo root with `git rev-parse --show-toplevel`, then `realpath` it (NOT `pwd` — worktrees/symlinks/moves derive the wrong slug). Build the candidate slug = that absolute path with `/` → `-`. Check `~/.claude/projects/<slug>/memory/`. **Show the operator the resolved path + the note count and require confirmation before reading.** If no dir matches, SAY SO (never silent-skip — the repo may have moved, so the CC dir is keyed to the old path). Never auto-proceed on a guessed slug.
</HARD-GATE>

<HARD-GATE name="gitignore">
Before writing a single line to `MEMORY.md`, deterministically ensure `MEMORY.md` is gitignored in this repo (`git check-ignore MEMORY.md` must succeed; if not, add `MEMORY.md` to the project `.gitignore` and re-verify). If it cannot be guaranteed gitignored, **ABORT** — do not write. `MEMORY.md` holds operator knowledge and must stay local/private (mirrors how the CC native memory lives outside the repo).
</HARD-GATE>

<HARD-GATE name="secret-scan">
PORT content passes a **deterministic secret scan** (fail-closed, independent of the LLM) before it is written: regex/high-entropy for tokens, bearer strings, signed/presigned URLs, known key prefixes (`sk-`, `AIza`, `ghp_`, 32+ hex), `.env`/credential values, and PII (names/phones/emails of end users). Any hit → that note is NOT written as-is; the operator decides redact-line vs whole-note-drop. The LLM classification is an aid, not the gate.
</HARD-GATE>

<HARD-GATE name="human-confirm">
No autonomous secret classification. Present the per-note classification table (PORT/SKIP/SENSITIVE + reason) and get operator confirmation on the buckets before writing. The single manual run that seeded this skill looked clean because a human eyeballed every note — keep the human.
</HARD-GATE>

## Classification (per note → one bucket)

- **PORT** — operational/decisional knowledge, NOT derivable from code, NOT already in the project `CLAUDE.md`, NOT sensitive, still useful on a future run. → translate into a `MEMORY.md` entry.
- **SKIP** — already covered by a `CLAUDE.md` invariant, OR code-derivable (surveying gets it), OR a dated/ephemeral run report (E2E logs, deploy post-mortems, POC reports, test-flake notes). → drop.
- **SENSITIVE** — touches secrets/keys/tokens/credentials topology or end-user PII. → **does NOT go to `MEMORY.md`, and does NOT auto-route to `mv`.** `mv` recall is searchable/embeddable and surfaces notes cross-context — it is NOT a clean secret sink. SENSITIVE stays in the CC memory (left in place, read-only); only the operator may explicitly choose to move a sanitized version elsewhere.

**Bias rules:**
- When unsure PORT vs SKIP → **SKIP** (under-importing a duplicate is cheap and recoverable; a missed PORT gets re-derived by survey or the next run). Especially: bias SKIP for any note that plausibly overlaps the project `CLAUDE.md`.
- When unsure about sensitivity → **SENSITIVE** (err toward not writing).
- **Partial sensitivity** (a useful note with one secret line) has no whole-note bucket — operator chooses redact-the-line (keep the rest) or drop-the-note.

## Staleness gate (code-claim notes)

A PORT note that makes a **claim about current code** (a bug, a function shape, an open backlog item) must be **grep-verified against HEAD** at import time. If it still holds → import. If it can't be cheaply verified → import it **tagged `unverified, as-of <note-date>`** so the planner discounts it. Pure platform/decision notes (a platform limit, a rejected library, a storage gotcha) are durable and exempt. Never launder a dated claim into an authoritative present-tense `MEMORY.md` line — the planner reads `MEMORY.md` before decomposing and a stale "fact" actively misguides it.

## Procedure

1. **Locate + confirm** (HARD-GATE slug-confirm).
2. **Read** the CC `memory/MEMORY.md` index, then each note file (read-only).
3. **Classify** every note into PORT/SKIP/SENSITIVE with the bias rules; build the table.
4. **Human-confirm** the table (HARD-GATE human-confirm).
5. **Secret-scan** PORT content (HARD-GATE secret-scan); resolve any hit with the operator.
6. **Staleness-verify** code-claim PORT notes against HEAD; tag or drop.
7. **Translate** PORT notes into the OC `MEMORY.md` format — the index-line + two-section body shape is owned by `oc-distilling-learnings`; load it (`skill({ name: "oc-distilling-learnings" })`) and follow its "Project pattern → MEMORY.md" section. No Claude frontmatter, no `metadata.type`. Atomize "and" notes into separate entries (one note = one concept).
8. **Gitignore-gate** then **write** `MEMORY.md` (HARD-GATE gitignore).
9. **Mark once** — add `<!-- cc-memory imported <date> -->` to the OC `MEMORY.md` (OC-side marker; never write `~/.claude`). On a re-run, if the marker exists, ask the operator before re-importing.

## Anti-patterns

- **Folding this into `oc-surveying-codebase`** — never. Survey is code-only and forbidden from `~/.claude`; mixing a secret-classifying foreign-memory importer into it merges two opposite trust profiles on the normal-operation code path.
- **Auto-running on cold-start** — never. The fan-out over many repos with LLM secret-classification is exactly the fail-open leak machine this design avoids.
- **Routing SENSITIVE to `mv`** — no; `mv` is not a secret sink.
- **Trusting `pwd` for the slug** — use `git rev-parse --show-toplevel` + realpath.
- **Importing dated run-reports or CLAUDE.md duplicates** — SKIP them.
