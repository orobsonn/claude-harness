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

test("passes the frozen runtime model strategy into plan validation", () => {
  const strategy = { hand_tiers: { low: "openai/gpt-5.6-luna", medium: "openai/gpt-5.6-luna", high: "openai/gpt-5.6-terra" } };
  let received;
  const decision = decidePlanGate(
    { plan: { kind: "full", mode: "full", tasks: [{}] }, expectedModelStrategy: strategy },
    { validatePlanFn: (_plan, options) => {
      received = options;
      return { ok: true, errors: [] };
    } },
  );
  assert.equal(decision.decision, "allow");
  assert.deepEqual(received, { expect: "full", expectedModelStrategy: strategy });
});
