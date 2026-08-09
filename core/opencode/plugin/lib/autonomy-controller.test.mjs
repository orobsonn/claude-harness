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

test("autonomy continuation stays silent for product hold, completed session, final-review, and non-plan modes", async () => {
  const { decideAutonomyContinuation } = await import(MODULE_URL);

  assert.deepEqual(
    decideAutonomyContinuation({ autonomy_directive: "enabled", classified: true, product_decision_pending: true }),
    { action: "none", reason: "product-decision" },
  );
  assert.deepEqual(
    decideAutonomyContinuation({ autonomy_directive: "enabled", classified: true, session_status: "completed" }),
    { action: "none", reason: "completed" },
  );
  assert.deepEqual(
    decideAutonomyContinuation({
      autonomy_directive: "enabled",
      classified: true,
      mode: "LIGHT",
      planner_status: "usable",
      plan_review_verdict: "APPROVE",
      final_review_done: true,
    }),
    { action: "none", reason: "final-review-done" },
  );
  assert.deepEqual(
    decideAutonomyContinuation({
      autonomy_directive: "enabled",
      classified: true,
      mode: "no-ceremony",
      planner_status: "not_started",
    }),
    { action: "none", reason: "mode-without-delivery-loop" },
  );
  assert.deepEqual(
    decideAutonomyContinuation({
      autonomy_directive: "enabled",
      classified: true,
      mode: "QUICK",
      planner_status: "not_started",
    }),
    { action: "none", reason: "mode-without-delivery-loop" },
  );
});

test("high adversary finding pauses autonomous continuation", async () => {
  const { decideAutonomyContinuation, hasHighAdversaryFinding } = await import(MODULE_URL);
  assert.equal(hasHighAdversaryFinding('{"issues":[{"severity":"high"}]}\nExtra context: {ignored}'), true);
  assert.equal(hasHighAdversaryFinding('{"issues":[{"severity":"medium"}]}'), false);
  assert.deepEqual(
    decideAutonomyContinuation({ autonomy_directive: "enabled", classified: true, autonomy_adversary_hold: true }),
    { action: "none", reason: "high-adversary-finding" },
  );
});

test("autonomy continues the delivery loop only until final_review_done is stamped", async () => {
  const { decideAutonomyContinuation } = await import(MODULE_URL);

  assert.deepEqual(
    decideAutonomyContinuation({
      autonomy_directive: "enabled",
      classified: true,
      mode: "LIGHT",
      planner_status: "usable",
      plan_review_verdict: "APPROVE",
    }),
    { action: "continue", phase: "delivery-loop" },
  );
});

test("readOperatorModel accepts any provider the operator is already using", async () => {
  const { readOperatorModel } = await import(MODULE_URL);

  assert.deepEqual(
    readOperatorModel({ providerID: "xai", modelID: "grok-4.5" }, "high"),
    { providerID: "xai", modelID: "grok-4.5", variant: "high" },
  );
  assert.deepEqual(
    readOperatorModel({ providerID: "openai", modelID: "gpt-5.6-terra" }),
    { providerID: "openai", modelID: "gpt-5.6-terra" },
  );
  assert.equal(readOperatorModel(null), null);
  assert.equal(readOperatorModel({ providerID: "xai" }), null);
});
