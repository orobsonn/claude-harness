# Pi evidence transport and planning refinement

## Scope

Keep native command evidence accessible to project-scoped reviewers, including
nonzero test runs. Refine planner/reviewer prose for executable outcome boundaries,
without changing model routing, approval criteria, plan schema or task-count gates.

## Evidence regression

`core/pi/extensions/harness-command-evidence.test.mjs` runs the pinned native Bash
and read tools. It checks complete long output, exit 1, a large diff, timeout,
storage failure and per-call/session binding. A native `createAgentSession` with
a synthetic provider also exercises the real update → tool-result pipeline.
The model response is synthetic; shell execution and file transport are real.
The accessibility tests failed without the transport hook and passed with it.

The transport only copies the native spool, after its writer has closed. Short
output remains inline. A file manually redirected to an arbitrary temporary path
is not automatically exported; the runtime prose directs the parent to use stdout
or a readable artifact in ephemeral project state. Raw output is not sanitized,
does not establish freshness, and does not confer approval.

## Planning exercise

Two fresh, read-only Sol/high consumers used the same updated planner/reviewer
prose and [fixed synthetic context](fixtures/pi-planning-pressure.md). They returned
three and five tasks respectively. Both separated persistence/claim contracts,
remote resolution and final composition; both specified valid concurrent winners,
exact ownership, atomic exclusion, safe identifiers and uncertain-response handling.
Both rejected a monolithic unresolved task and artificial per-helper/per-test
fragmentation. Both accepted one task for the independent formatter change.

This is a bounded qualitative exercise, not a native Pi delivery run, statistical
proof of consistency, or evidence that a particular task count is optimal. No
baseline A/B comparison was run. Follow-up product runs should assess unresolved
decisions, review corrections and total coordination cost, not task count alone.
