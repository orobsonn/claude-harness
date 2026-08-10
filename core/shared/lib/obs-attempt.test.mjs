import test from "node:test";
import assert from "node:assert/strict";
import { currentAttemptEvents, nextAttemptNumber } from "./obs-attempt.mjs";

test("attempt epoch keeps the complete audit but exposes only the current suffix", () => {
  const events = [
    { type: "picked" },
    { type: "spec-created" },
    { type: "plan-created", tasks: 3 },
    { type: "attempt-started", attempt: 2 },
    { type: "picked" },
  ];
  assert.deepEqual(currentAttemptEvents(events), [{ type: "picked" }]);
  assert.equal(nextAttemptNumber(events), 3);
});

test("attempt epoch is fail-open for malformed input and legacy runs", () => {
  assert.deepEqual(currentAttemptEvents(null), []);
  assert.deepEqual(currentAttemptEvents([{ type: "picked" }]), [{ type: "picked" }]);
  assert.equal(nextAttemptNumber([]), 2);
});
