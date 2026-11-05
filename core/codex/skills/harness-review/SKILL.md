---
name: harness-review
description: Use for code review, plan review, adversarial review, compliance review, or security review.
---

# harness-review

Lead with concrete findings that affect correctness, security, delivery scope, or test confidence.

- Use read-only eyes and inspect the actual diff, tests, entry points, and boundaries.
- A finding needs evidence plus reproduction or precise rationale.
- Distinguish blocked, unarmed, advisory, and accepted residual risks.
- Complete one bounded pass and report the material findings together. After a correction,
  review its delta and concrete impacts rather than restart unrelated exploration.
- A current non-material imperfection may be an accepted residual with evidence of its
  limited consequence, existing containment/recovery and justification. Rarity alone
  does not justify accepting an unmet mandatory criterion or material safety/correctness
  failure. Do not turn style preference into a blocker or omit a material failure.
- Conclude when the approved criteria and required evidence are satisfied and no material
  defect remains demonstrated; no extra review round or external issue is needed solely
  to record residuals. Preserve the runtime's normal report and approval contracts.

For a structured eye report, validate it with
`node -e 'import("./.codex/lib/review-contracts.mjs")'`; the module is a pure
validator/merger and never dispatches or retains workflow state.

Use `.codex/skills/harness-rules/references/governance-contract.md` for the
adversarial method and `.codex/skills/harness-delivery/references/delivery-contract.md` for completion evidence.
