# Kaizen — Harness-Improvement Proposals (outbox)

A committed outbox for improvements to the **harness itself** (an agent, skill, or rule) discovered
during a run. This is **not** project memory (that lives in `.claude/memory/`) — it is a queue of
proposals addressed to the human who maintains the framework.

Flow:
1. Any run (local or cloud) that spots a possible harness improvement **appends** a proposal below.
2. In headless mode the proposal travels in the PR — it does not evaporate with the session.
3. The human drains this outbox during PR review and promotes worthy items to the framework source
   (`core/`), from where they are re-vendored into every project on the next init.
4. **Never auto-applied** — promotion is always a human decision.

**Never write secrets, credentials, or PII here — this file is committed to git.**

## Proposals

<!-- append proposals below, e.g.:
### <date> — executor: stricter scope_paths enforcement
- **Observed:** ...
- **Proposed change:** ...
- **Rationale:** ...
-->
