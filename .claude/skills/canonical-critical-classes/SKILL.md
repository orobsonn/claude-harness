---
name: canonical-critical-classes
description: "Load when ATTACKING (adversary) or VERIFYING (compliance) an implementation. Carries the canonical taxonomy of critical failure classes — the known killers from the operator's systems-primitives model — plus the irreversibility-first criticality ranking. Use it to hunt the bug that makes the system UNVIABLE, never to fill a finding quota. Role-neutral: HOW each role acts lives in that agent's prompt."
---

# Canonical Critical Classes — the known killers, ranked by irreversibility

The canonical failure mechanisms from the operator's systems-primitives model — **not** a generic OWASP list. Shared vocabulary: the **adversary** hunts these (as a floor, not a ceiling); **compliance** uses the list to know which classes, when present in a diff, require a corresponding test. The HOW for each role lives in that agent's prompt — this file is the taxonomy and the ranking.

## Rank criticality BEFORE labelling severity

Rank by blast radius, not gut feel. Munger sequence: **irreversibility → weakest link → second/third order.**

- **Irreversibility** — does it corrupt persisted state, lose data, or fire an external side effect (publish, charge, delete) that cannot be rolled back? Irreversible is top, always.
- **Weakest link** — orphan state surfaces first at the least-monitored component.
- **n-th order** — ask "and then what?" at least twice; a change correct locally can corrupt a downstream write, a retry, or a sibling under concurrency.

A bug that is local, reversible, and cosmetic is never top severity, even if real.

## The canonical classes

For each, the question that exposes it:

1. **Orphan state / overwrite class** — state no component formally owns: a value in a shared blob/column that a whole-row or bulk writer clobbers; a partial write left inconsistent. *Who ELSE writes this field/row? does a bulk / patch / regen path erase it? is there a survival test across ALL writers?* A dedicated column is immune by construction; a shared JSON blob is not. (Historically high-yield — but the list is a floor; vary your entry point per task.)
2. **Idempotency / retry-corruption** — a non-idempotent op turns failure-recovery into corruption. *What happens on retry, double-delivery, re-run? is there a natural key / guard that makes the second execution a no-op?*
3. **Concurrency / race** — TOCTOU, non-atomic read-modify-write, election under parallelism, lost update, double-spend. *Is the critical decision made single-threaded, or under concurrency? is shared mutable state guarded atomically?* A race is not testable away reliably — judge the design, never accept a green happy-path test as proof it is gone.
4. **Determinism / reproducibility** — non-deterministic output where reproducibility is required (ordering, seeds, selection). *Same inputs → same output, run twice?*
5. **Operator-locked-decision violation / user-model gap** — does the code honor the operator's locked decisions (intervals, inclusions/exclusions, weightings, scope boundaries) and match the user's mental model? A violated locked decision is critical even if every AC passes.
6. **Boundary / API contract** — interface assumptions, type confusion, truncation, unvalidated external input at the edge; attack surface grows with each new integration/dependency.
7. **Auth / injection / secret-leak** — auth-bypass, missing authz, SQL/command/path injection, secret or stack leaked in a response, open redirect, IDOR, timing attack.
8. **Cost / scale** — works at 10, breaks at 10k: unbounded growth, missing limit/timeout, throughput/inference cost that explodes with volume.
