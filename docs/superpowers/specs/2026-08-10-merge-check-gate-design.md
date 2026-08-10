# Merge Check Gate — Design

## Goal

Every official harness merge proceeds only when GitHub checks for the exact pull request are
provably green. This covers the OpenCode delivery hook, Claude Code hook, and VPS review cron.

## Small shared contract

A dependency-free pure policy accepts an observation for one PR:

- `green`: at least one reported check and every required check has conclusion `success`,
  `neutral`, or `skipped`;
- `red`, `pending`, `missing`, `ambiguous`, or `unavailable`: deny.

The I/O adapters are deliberately thin and specific to their existing boundary: they identify the
exact PR, request check data, normalize it to the policy observation, and never interpret status
inside the delivery state machine. The VPS adapter invokes the same policy immediately before its
TOCTOU-protected merge.

## Scope boundary

Covered: OpenCode/Claude Code `gh pr merge` through their harness hooks, plus VPS cron merge.
Not covered: GitHub web UI, raw curl/git, or arbitrary shells outside a harness process. Those need
server-side protection, unavailable on this repository plan.

## Failure policy

Fail closed. A network failure, rate limit, no reported checks, no required checks, an unresolved
PR target, or an unknown conclusion is not evidence that the PR is green. The denial must say that
the operator should wait for/repair the checks or resolve the PR explicitly.

## Non-goals

No check database, polling worker, cache, background retry, or platform-wide command monitor.
