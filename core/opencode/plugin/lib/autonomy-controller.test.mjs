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

test("continuation prompt pins the operator session model so agent frontmatter cannot overwrite it", async () => {
  const {
    continuationPromptModelFields,
    normalizeOperatorSessionModel,
    resolveContinuationSessionModel,
  } = await import(MODULE_URL);

  assert.deepEqual(
    normalizeOperatorSessionModel({ providerID: "xai", modelID: "grok-4.5", variant: "high" }),
    { providerID: "xai", modelID: "grok-4.5", variant: "high" },
  );
  assert.equal(normalizeOperatorSessionModel({ providerID: "xai" }), null);
  assert.deepEqual(
    continuationPromptModelFields({ providerID: "xai", modelID: "grok-4.5", variant: "high" }),
    {
      model: { providerID: "xai", modelID: "grok-4.5" },
      agent: "build",
      variant: "high",
    },
  );
  assert.deepEqual(continuationPromptModelFields(null), {});

  const fromMessages = resolveContinuationSessionModel({
    messages: [
      {
        info: {
          role: "user",
          model: { providerID: "xai", modelID: "grok-4.5" },
          variant: "high",
        },
        parts: [{ type: "text", text: "siga a implementacao de forma autonoma" }],
      },
      {
        info: {
          role: "user",
          model: { providerID: "openai", modelID: "gpt-5.6-terra" },
        },
        parts: [{ type: "text", text: "[HARNESS_AUTONOMY_CONTINUE]\nresume" }],
      },
    ],
  });
  assert.deepEqual(fromMessages, { providerID: "xai", modelID: "grok-4.5", variant: "high" });

  assert.deepEqual(
    resolveContinuationSessionModel({
      operatorModel: { providerID: "xai", modelID: "grok-4.5" },
      messages: [
        {
          info: { role: "user", model: { providerID: "openai", modelID: "gpt-5.6-terra" } },
          parts: [{ type: "text", text: "hello" }],
        },
      ],
    }),
    { providerID: "xai", modelID: "grok-4.5" },
  );
});
