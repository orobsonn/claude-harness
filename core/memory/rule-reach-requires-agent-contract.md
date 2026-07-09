---
name: rule-reach-requires-agent-contract
description: A convention added only to a core/rules/*.md file is decorative for any actor that cannot load rules (Skill-forbidden, no rule-injection hook) — it must also be inlined into that actor's own agent .md to actually reach it.
metadata:
  type: project
---

**Why:** `core/rules/*.md` files are loaded via the `Skill` mechanism (or a session-start hook) —
neither of which every actor has. `test-author` (`core/agents/test-author.md`) is a Read/Write-only
subagent: its frontmatter grants no `Skill` tool, its own anti-scope table forbids invoking one, and
its reads are scoped to the files a task's assertions name. No hook injects `core/rules/*.md` content
into a subagent's context. So a convention added ONLY to `core/rules/testing-unit.md` (e.g. "mock
fetch with `mockImplementation`, never `mockResolvedValue`") never reaches the one role that actually
writes that code — it is decorative documentation, not an enforced authoring convention. This was
independently confirmed by two model families (Claude spec-adversary + Codex cross-family) during
`vitest-fresh-response-mock` (#108).

**How to apply:** when a rule change is meant to change what a specific **hand** or **eye** actually
DOES (not just what a human reading `core/rules/` learns), identify which actor performs that action
and check its agent `.md` frontmatter `tools:` list. If `Skill` is absent (or the actor's own
anti-scope table forbids it) and no hook injects rule content into that actor's context, the
convention must be **inlined directly into that actor's agent `.md`** (in the relevant numbered step,
e.g. test-author §3 "Como transcrever") — not left only in `core/rules/`. `core/skills/initializing-
projects/references/vendor-core.mjs`'s `FRAMEWORK_OWNED = ["agents","skills","rules","hooks"]` copies
`core/agents/*.md` into every downstream project's `.claude/agents/`, so an inline there does reach
downstream actors on next `init`/update — confirm the target file is in `FRAMEWORK_OWNED` before
relying on that path. A rule-only edit is still worth keeping (human-facing documentation, and any
actor that DOES load rules), but treat it as insufficient on its own whenever the acting role is a
Read/Write-only hand.
