---
name: harness-brainstorming
description: Use before proposing or implementing a non-trivial product or architecture change.
---

# harness-brainstorming

Classify the request as no-ceremony, QUICK, LIGHT, or FULL. For LIGHT/FULL,
elicit product decisions one at a time and present the smallest viable design.

In an explicitly authorized autonomous/headless delivery, use the issue and prior
operator decisions as the product contract. Resolve non-blocking ambiguity with the
smallest safe, reversible choice inside that contract; record assumptions and submit
them to the adversary. Do not pause for routine confirmation or invent operator answers.
Stop when no safe in-scope option exists or new authority, sensitive/irreversible effects,
data destruction, migration, legal obligations or reduced security are required.

- State outcome, non-goals, tradeoffs, sensitive paths, and success evidence.
- Require explicit approval before implementation when a decision changes scope.
- Route architecture, security, scale, and isolation through a read-only adversary.
- Record accepted residual risk; do not convert uncertainty into an invented fact.

Use the full delivery gates in
`.pi/harness/skills/harness-delivery/references/delivery-contract.md` and the
adversarial protocol in `.pi/harness/skills/harness-rules/references/governance-contract.md`.
