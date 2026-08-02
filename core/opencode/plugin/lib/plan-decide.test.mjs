/** @description R15 downstream plan decision tests. */
import test from "node:test";
import assert from "node:assert/strict";
import { decidePlanGate } from "./plan-decide.mjs";

test("validator implementation failure warns and opens", () => {
  const decision = decidePlanGate({ plan: {} }, { validatePlanFn: () => { throw new Error("fault"); } });
  assert.deepEqual(decision, {
    ok: true,
    decision: "warn",
    reason: "[plan-gate] Warning: validator failed internally; opening without a validation decision.",
  });
});

test("a normal invalid R15 result still denies", () => {
  const decision = decidePlanGate({ plan: { kind: "full", mode: "full", tasks: [{}] } });
  assert.equal(decision.decision, "deny");
});
