/** @description Planner brief carries only the classified feature identity. */
import assert from "node:assert/strict";
import test from "node:test";
import { buildPlannerBriefAppendix } from "./planner-brief.mjs";

test("planner brief carries the locked feature identity", () => {
  const brief = buildPlannerBriefAppendix({
    featureId: "lead-timestamps",
    expectedModelStrategy: { hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" }, planner: "openai/gpt-5.6-sol" },
  });
  assert.match(brief, /\[HARNESS_SESSION_FEATURE_ID\]lead-timestamps\[\/HARNESS_SESSION_FEATURE_ID\]/);
  assert.match(brief, /"feature_id": "lead-timestamps" exactly/);
  assert.match(brief, /HARNESS_EXPECTED_MODEL_STRATEGY/);
  assert.match(brief, /"hand_tiers"/);
});

test("planner brief is absent without a classified feature identity", () => {
  assert.equal(buildPlannerBriefAppendix({ featureId: "" }), "");
});
