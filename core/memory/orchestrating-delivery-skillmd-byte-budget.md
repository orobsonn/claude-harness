---
name: orchestrating-delivery-skillmd-byte-budget
description: core/skills/orchestrating-delivery/SKILL.md has near-zero byte headroom against orchestrator-economy.test.mjs's hard budget gate — any edit to that file must run that specific test before considering the change done
metadata:
  type: project
---

**Why:** an earlier "Group D" delivery (orchestrator-context-cost discipline) put a deliberate hard
byte-budget ceiling on `core/skills/orchestrating-delivery/SKILL.md` (`< 96731` bytes, enforced by
`core/skills/orchestrating-delivery/references/orchestrator-economy.test.mjs`). The file sits so close
to that ceiling that a routine, small addition can blow the budget with no warning short of running the
test — in the `spec-adversary-checkpoint` feature (#260) a task-4 SKILL.md addition pushed the file
from 96606 to 97307 bytes and broke the gate; the fix that restored margin left only ~13 bytes of
headroom at one point.

**How to apply:** any edit to `core/skills/orchestrating-delivery/SKILL.md` — even a prose tweak — must
be followed by `node --test core/skills/orchestrating-delivery/references/orchestrator-economy.test.mjs`
before the change is considered done. Do not rely on the general full-suite run alone to surface this;
run the specific test explicitly, since it is easy to add a task-scoped edit without ever exercising a
byte-budget-adjacent gate in the same task's own frozen tests. When trimming prose to fit the budget,
re-verify every literal command block character-for-character (copy-paste, do not re-summarize) — a
byte-driven trim can silently drop a required flag from a documented command (see
`checkpoint-position-before-branching` for the related regression this caused).
