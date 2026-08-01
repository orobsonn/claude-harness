/** @description Shared projection tests for frozen planner model strategies. */
import test from "node:test";
import assert from "node:assert/strict";
import { projectExpectedModelStrategy } from "./model-strategy-projection.mjs";

const baseRoles = {
  planner: { model: "openai/planner" },
  "plan-reviewer": { families: { "family-1": { model: "openai/reviewer" } } },
  compliance: { model: "openai/compliance" },
  adversary: { families: { "family-1": { model: "openai/adversary" } } },
  security: { model: "openai/security" },
  shipper: { model: "openai/shipper" },
  harvester: { model: "openai/harvester" },
};

test("projects simple and family-1 primary eye routes with exact hand tiers", () => {
  const result = projectExpectedModelStrategy({ roles: baseRoles });
  assert.equal(result.ok, true);
  assert.deepEqual(result.strategy.hand_tiers, { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" });
  assert.equal(result.strategy["plan-reviewer"], "openai/reviewer");
  assert.equal(result.strategy.adversary, "openai/adversary");
});

test("rejects malformed expected strategy projections rather than producing a partial snapshot", () => {
  const result = projectExpectedModelStrategy({ roles: { ...baseRoles, security: {} } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /security/);
});
