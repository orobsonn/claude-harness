# Issue #446 Implementation Plan

**Goal:** Bind model-routing changes to host confirmation and the root lifecycle lane.

**Constraints:** Keep it as one config policy and one existing entry-gate branch. No new state,
daemon, approval record, or ceremony.

## Task 1 — Lock the policy contract

- [x] Add failing tests for root `ask` and `general`/`explore` deny in root and vendored config.
- [x] Add the minimal config rules.

## Task 2 — Bind runtime caller authority

- [x] Add failing entry-gate tests for root lifecycle permit, child deny, and other-agent deny.
- [x] Resolve only the official exact tool-call identity and reject unknown/conflicting evidence.
- [x] Add the smallest `configure-routing` entry-gate branch using that fact.

## Task 3 — Verify and ship

- [x] Run targeted tests and the full hermetic suite.
- [ ] Obtain adversarial review, publish the PR, merge, and cut the issue release.
