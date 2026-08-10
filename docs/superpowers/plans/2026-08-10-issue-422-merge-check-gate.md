# Issue #422 Implementation Plan

**Goal:** Deny every official harness merge unless the exact PR's checks are demonstrably green.

## Task 1 — Define one pure decision

- [ ] Write failing tests for green, failed, pending, absent, unknown, and unavailable checks.
- [ ] Implement one small shared check-status policy with explicit accepted conclusions.

## Task 2 — Connect each official merge path

- [ ] Add failing tests for OpenCode and Claude Code merge commands: query only on merge, pass only
      the exact PR target, and deny query failures.
- [ ] Add a failing VPS merge test showing checks run before every merge retry.
- [ ] Add thin adapters; no I/O in pure policy and no duplicated status interpretation.

## Task 3 — Verify, review, release

- [ ] Run targeted suites plus `npm test`.
- [ ] Obtain adversarial review, publish, merge, and release.
