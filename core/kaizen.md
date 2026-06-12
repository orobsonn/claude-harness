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

### 2026-06-12 — entry-gate: gate Bash delivery door while re-gate is pending

- **Observed:** The re-gate block (sniper HIGH fix awaiting strong-eye re-gate) is deterministic only
  for the SHIPPER Agent dispatch (PreToolUse `Agent` hook in `entry-gate.mjs`). A direct Bash call
  — `git push`, `gh pr create` — bypasses the gate entirely. In v1, the `orchestrating-delivery`
  convention is the single door (delivery always goes through the shipper Agent), so the risk is low.
  But it relies on convention, not enforcement.
- **Proposed change:** Extend the entry-gate's PreToolUse to also intercept `Bash` tool calls whose
  command matches `git push`, `gh pr`, `gh pr create`, or similar delivery patterns. When
  `regate_pending` is non-empty, block and return the same "re-gate required" error as the Agent gate.
- **Rationale:** Defense-in-depth. The shipper is the intended single door, but a Bash shortcut in a
  subagent (or a future script) would silently bypass the re-gate obligation. Closing the Bash door
  is cheap and makes the guarantee unconditional rather than convention-dependent.

### 2026-06-12 — creating-plans: locked_test must pin the FULL invariant, not a happy-path example

- **Observed:** In the `contract-split` task the adversary caught a frozen test that covered only 1 of
  7 eye roles in the eye→Ollama guard. The freeze "passed" but was a hole — it would have allowed a
  regression in the other 6 roles to ship undetected through the deterministic rail.
- **Proposed change:** Add an explicit rule to `creating-plans/SKILL.md` under the test-pin checklist:
  "When authoring a locked_test for an invariant with multiple branches/roles/states, the frozen test
  MUST cover ALL branches. A happy-path-only freeze is a hole. The compliance eye validates fidelity
  BEFORE freeze — it must explicitly check branch coverage."
- **Rationale:** The deterministic rail's safety guarantee rests on the frozen test being a sound
  specification. A partial freeze is worse than no freeze — it creates false confidence while missing
  the cases most likely to regress.

### 2026-06-12 — entry-gate: harden non-array regate_pending (currently fail-open)

- **Observed:** The gate reads `regate_pending` from `gate-state.json` and treats a non-array value
  (e.g. corrupted state) as an empty array → fail-open (delivery proceeds). This is consistent with
  the harness's "fail-open on infra error" contract, but a corrupted `regate_pending` specifically
  masks a pending re-gate obligation, which is a safety concern.
- **Proposed change:** Distinguish infra errors (file not readable → fail-open as today) from corrupt
  state (file readable but `regate_pending` is not an array → fail with an explicit "gate-state
  corrupted" error rather than treating it as empty). Log the raw value for debugging.
- **Rationale:** A corrupted `regate_pending` is not an infra failure — the state file exists but its
  content is wrong. Failing closed on corrupt state (rather than silently dropping the obligation)
  is safer and easier to diagnose.

### 2026-06-12 — SKILL.md authoring: routing-table rows must be uniquely named or tests must filter-all

- **Observed:** `orchestrating-delivery/SKILL.md` has duplicate rows for `adversary`, `compliance`, and
  `security` (one row for the per-task gate, one for the final dual-review gate). A test that uses
  `find-first` on role name will silently match only the first occurrence and miss the second,
  producing a false positive ("role is correctly not using Ollama") while the second row is wrong.
- **Proposed change:** Either (a) require unique role identifiers in routing tables by adding a
  qualifier (`adversary (per-task)` vs `adversary (final-gate)`), or (b) add a convention note to the
  SKILL authoring guide that parsing tests must use `filter-all` (find every matching row) rather than
  `find-first`. Option (a) is preferable — it removes the ambiguity at the source.
- **Rationale:** Routing-table integrity tests are the proof that model routing is correctly
  configured. A test that silently matches the wrong row provides no safety. Unique row identifiers
  make the table both human-readable and machine-verifiable without special test logic.
