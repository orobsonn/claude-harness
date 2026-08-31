---
name: harness-delivery
description: Use to execute an approved delivery plan with TDD, scoped subagents, and verification.
---

# harness-delivery

Run entry triage first and execute only an approved, bounded plan.

- Resolve role and complexity before every dispatch; include evidence expected.
- Delegate only independent work; hands cannot widen scope or self-approve.
- For every implementation change: red test, minimal green code, affected suite.
- At the end, verify acceptance criteria, diff, docs, risks, and residuals.

The authoritative operational sequence is
`.codex/skills/harness-delivery/references/delivery-contract.md`. Apply the
security constraints from `.codex/skills/harness-rules/references/governance-contract.md`.
