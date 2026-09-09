# Bounded planning exercise

This is a synthetic, read-only evaluation of planning prose, not a delivery plan
or an instruction to dispatch a product pipeline. Use the supplied planner prose
to propose outcome/dependency boundaries; return the proposal without writing
files. The code facts below are the complete fixed context for this exercise.

## Context and approved outcome

A service must make publishing retry-safe after an uncertain external response.
The stable ceremony is FULL. Existing `src/store.ts` loads publication records;
`src/publish.ts` exposes `publish()` and contains the external client wrappers;
`tests/store.test.ts` and `tests/publish.test.ts` exercise those public boundaries.
These modules already exist and are importable. There is no constraint requiring
new files or helpers. The existing publish integration has eager-insert assertions
that must be updated when persistence moves ahead of external mutation.

Required behavior:

- Persist and reload the originally chosen target and any reusable remote ID.
- Exact-name lookup must paginate until a match or exhaustion. An uncertain
  create response must not cause an automatic second create within that call.
- An empty target is claimed conditionally. Read back the winner: zero changed
  rows with a valid competing winner continues with that winner; zero rows with
  no valid winner fails before any external write.
- Resource ownership is exact string equality, not trimmed equality. Claiming a
  reusable resource must exclude another owner's reference atomically in the
  same conditional update, not by an earlier independent SELECT.
- Nonempty remote identifiers from either persisted state or the external
  response must satisfy the same existing path-segment safety contract before
  being used in an external endpoint.
- `publish()` composes persistence, lookup and recovery so an uncertain attempt
  reuses its target or existing remote object instead of duplicating the write.

No new infrastructure, generic validation framework, exhaustive input matrix,
fixed number of tasks, or unrelated refactor is authorized.

## Requested output

Propose tasks with outcome, critical decisions, write paths, dependencies and
smallest observable proof. Explain any shared-file sequencing and any behavior
kept together. State which, if any, responsibilities would otherwise force the
executor to do another planning exercise inside a task. Do not optimize for a
particular number of tasks.

Then evaluate these decomposition alternatives independently:

1. One task "implement everything" owns both modules and both test files. It
   copies the criteria but leaves their dependency contracts and valid/invalid
   outcome distinctions to the executor.
2. Separate tasks for each test, each helper, every conditional branch and a
   final task that makes the earlier frozen tests importable.
3. A cohesive small change outside this service: change a formatter to render
   absent labels as `unknown`, with one regression at its existing public API.

For each, explain whether a revision is warranted and the concrete correction,
without imposing a universal task count or splitting an atomic invariant.
