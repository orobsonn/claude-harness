---
name: checkpoint-position-before-branching
description: An observability checkpoint that "fires at the verdict" must be positioned in the SKILL.md BEFORE any subsequent stop/proceed branching, not after — textual position in an LLM-read SKILL.md is load-bearing, not cosmetic
metadata:
  type: project
---

**Why:** in the `spec-adversary-checkpoint` feature (#260) final dual review, the cross-family
(codex) adversary found that the new `spec-adversaried` marker instruction, even after content fixes,
was positioned textually AFTER HARD-GATE 1's HEADLESS stop-and-report branch in
`core/skills/orchestrating-delivery/SKILL.md`. An orchestrator following the doc top-to-bottom on a
BLOCK verdict with an unresolvable issue could read "stop and report" and never reach the checkpoint
line below it — silently skipping the exact marker this feature exists to guarantee. The doc is read
and executed by an LLM in linear order; a semantically "fires at the verdict" instruction that is
placed after a branch that can exit early is not reliably reached, regardless of what the prose says
about when it conceptually happens.

**How to apply:** when adding or editing a deterministic checkpoint/marker instruction tied to a gate
verdict, place it immediately after the step that produces the verdict and BEFORE any stop/proceed
branching (including the HEADLESS early-exit branch) that could short-circuit past it. Phase 1's
`plan-reviewed` checkpoint has this SAME positional defect today (sits after HARD-GATE 2's
stop-and-report branch) — out of scope for #260 per its locked scope_paths, tracked as a kaizen
proposal for a follow-up fix.
