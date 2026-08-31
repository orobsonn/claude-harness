---
name: harness-brainstorming
description: Use before proposing or implementing a non-trivial product or architecture change.
---

# harness-brainstorming

Classify the request as no-ceremony, QUICK, LIGHT, or FULL. For LIGHT/FULL,
elicit product decisions one at a time and present the smallest viable design.

- State outcome, non-goals, tradeoffs, sensitive paths, and success evidence.
- Require explicit approval before implementation when a decision changes scope.
- Route architecture, security, scale, and isolation through a read-only adversary.
- Record accepted residual risk; do not convert uncertainty into an invented fact.

Use the full delivery gates in
`.codex/skills/harness-delivery/references/delivery-contract.md` and the
adversarial protocol in `.codex/skills/harness-rules/references/governance-contract.md`.
