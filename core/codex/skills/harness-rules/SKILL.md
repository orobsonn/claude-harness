---
name: harness-rules
description: Use when writing delivery rules, assessing critical failure classes, or changing policy.
---

# harness-rules

Keep policy concise and outcome-focused.

- Put deterministic checks in tests, rules, or hooks only at high-leverage boundaries.
- Treat sandbox and approvals as the security boundary, never the prompt alone.
- Document every hook matcher, bypass, residual risk, and unsupported control.
- Add a regression before expanding a deny rule; preserve safe recovery paths.

The policy baseline is `.codex/skills/harness-rules/references/governance-contract.md`.
Use `.codex/skills/harness-delivery/references/delivery-contract.md` for the TDD evidence cycle.
