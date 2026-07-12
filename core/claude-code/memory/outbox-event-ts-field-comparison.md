---
name: outbox-event-ts-field-comparison
description: Any test asserting an observability outbox event's shape must compare fields individually, never whole-object deepEqual — appendEvent (obs-outbox.mjs) always stamps a `ts` field the caller never provides
metadata:
  type: project
---

**Why:** `appendEvent` in `core/hooks/obs-outbox.mjs` unconditionally adds a `ts` timestamp to every
event it writes, regardless of what the producer passed in. A test that builds an expected event
object and compares it with `assert.deepEqual(actualEvent, expectedEvent)` will always fail — not
because the producer is wrong, but because the expected object can never predict the stamped `ts`.
This broke task-2's (`stamp-triage.mjs`) fidelity gate on first pass in the `spec-adversary-checkpoint`
feature (#260) before being caught and fixed.

**How to apply:** when asserting an outbox event written via `appendEvent`, compare the fields you
actually control individually (e.g. `assert.equal(event.type, "...")`, `assert.equal(event.verdict,
"...")`, `assert.equal(event.findings, n)`) — never `assert.deepEqual`/`assert.deepStrictEqual` the
whole event object against a hand-built literal. If you need to assert the shape is otherwise complete,
assert on `Object.keys(event)` explicitly including `"ts"`, rather than value-comparing it.
