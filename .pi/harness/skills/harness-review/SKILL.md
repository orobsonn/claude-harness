---
name: harness-review
description: Use for code review, plan review, adversarial review, compliance review, or security review.
---

# harness-review

Lead with concrete findings that affect correctness, security, delivery scope, or test confidence.

- Use read-only eyes and inspect the actual diff, tests, entry points, and boundaries.
- A finding needs evidence plus reproduction or precise rationale.
- Distinguish blocked, unarmed, advisory, and accepted residual risks.
- Do not turn style preference into a blocker or omit a real failure for politeness.

For a structured eye report, validate it with
`node -e 'import("./.pi/harness/vendor/codex/lib/review-contracts.mjs")'`; the module is a pure
validator/merger and never dispatches or retains workflow state.

Use `.pi/harness/skills/harness-rules/references/governance-contract.md` for the
adversarial method and `.pi/harness/skills/harness-delivery/references/delivery-contract.md` for completion evidence.
