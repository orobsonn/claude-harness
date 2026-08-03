/** @description Regression contract for autonomous delivery continuation decisions. */
import test from "node:test";
import assert from "node:assert/strict";

const MODULE_URL = new URL("./autonomy-controller.mjs", import.meta.url);

test("autonomy directive recognizes implementation and delivery wording used by the operator", async () => {
  const { detectsAutonomyDirective } = await import(MODULE_URL);

  for (const message of [
    "siga a implementacao",
    "pode seguir autonomamente ate entregar",
    "nao pare ate finalizar",
    "rode de forma autonoma",
    "sem me perguntar, resolve a engenharia",
  ]) {
    assert.equal(detectsAutonomyDirective(message), true, message);
  }
  assert.equal(detectsAutonomyDirective("qual e o estado da implementacao?"), false);
});

test("autonomy continuation names the mandatory plan review before any implementation", async () => {
  const { decideAutonomyContinuation } = await import(MODULE_URL);

  assert.deepEqual(
    decideAutonomyContinuation({
      autonomy_directive: "enabled",
      classified: true,
      planner_status: "usable",
    }),
    { action: "continue", phase: "plan-review" },
  );
});

test("autonomy continuation stays silent only for a product decision or a completed session", async () => {
  const { decideAutonomyContinuation } = await import(MODULE_URL);

  assert.deepEqual(
    decideAutonomyContinuation({ autonomy_directive: "enabled", classified: true, product_decision_pending: true }),
    { action: "none", reason: "product-decision" },
  );
  assert.deepEqual(
    decideAutonomyContinuation({ autonomy_directive: "enabled", classified: true, session_status: "completed" }),
    { action: "none", reason: "completed" },
  );
});
