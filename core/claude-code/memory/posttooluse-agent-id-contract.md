---
name: posttooluse-agent-id-contract
description: PostToolUse[Agent] payload contract — agent_id key presence marks main-loop vs nested dispatch
metadata:
  type: project
---

**Why:** every PostToolUse[Agent] hook in the harness (`entry-gate.mjs`, `stamp-triage.mjs`,
`plan-write-gate.mjs`, `codex-eye-nudge.mjs`, `obs-eye-append.mjs`, `agent-idle-nudge.mjs`) must
decide whether a given Agent dispatch came from the top-level main loop or from a nested/subagent
call, because several behaviors (gating, re-gate stamping, cross-family nudges, idle nudges) are
main-loop-only. Verified this session (#90, entry-gate observed gating main-loop dispatches): a
**main-loop** Agent dispatch payload OMITS the `agent_id` key entirely; a **nested/subagent**
dispatch INCLUDES it (possibly with a falsy value like `''` or `0`).

**How to apply:** guard "main-loop only" with a **presence check**, never truthiness —
`Object.prototype.hasOwnProperty.call(payload, 'agent_id')` returns `true` → nested dispatch, skip.
Truthiness (`if (payload.agent_id)`) is wrong: a nested dispatch with a falsy-but-present `agent_id`
(`''`/`0`) would be misread as main-loop. `entry-gate.mjs`, `stamp-triage.mjs`,
`plan-write-gate.mjs`, and `agent-idle-nudge.mjs` already use the presence-check; `codex-eye-nudge.mjs`
and `obs-eye-append.mjs` still use truthiness (flagged in `kaizen.md`, 2026-07-07, for alignment —
not yet fixed).
