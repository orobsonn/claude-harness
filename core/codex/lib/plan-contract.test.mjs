import assert from "node:assert/strict";
import test from "node:test";
import { validateDeliveryPlan } from "./plan-contract.mjs";

const fullPlan = {
  tier: "FULL",
  tasks: [{
    id: "task-routing",
    files: ["core/codex/model-routing.mjs"],
    red_test: "node --test core/codex/model-routing.test.mjs",
    minimal_implementation: "add the narrow route resolver",
    green_test: "node --test core/codex/model-routing.test.mjs",
    verification: "npm test",
    route: { role: "executor", complexity: "medium" },
  }],
};

test("FULL plan requires a bounded TDD task and an explicit, routable Codex dispatch", () => {
  assert.deepEqual(validateDeliveryPlan(fullPlan), { ok: true, errors: [] });
  const missingRed = structuredClone(fullPlan);
  delete missingRed.tasks[0].red_test;
  assert.match(validateDeliveryPlan(missingRed).errors.join("\n"), /red_test/);
  const unknownRoute = structuredClone(fullPlan);
  unknownRoute.tasks[0].route.role = "invented";
  assert.match(validateDeliveryPlan(unknownRoute).errors.join("\n"), /unsupported route/);
});

test("QUICK does not masquerade as a mutable multi-task engine", () => {
  assert.deepEqual(validateDeliveryPlan({ tier: "QUICK", tasks: [] }), { ok: true, errors: [] });
  assert.match(validateDeliveryPlan({ tier: "QUICK", tasks: [{ id: "unnecessary" }] }).errors.join("\n"), /QUICK/);
  assert.match(validateDeliveryPlan(null).errors.join("\n"), /object/);
});
