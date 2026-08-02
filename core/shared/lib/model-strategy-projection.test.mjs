/** @description Shared projection tests for frozen planner model strategies. */
import test from "node:test";
import assert from "node:assert/strict";
import { projectExpectedModelStrategy } from "./model-strategy-projection.mjs";

const baseRoles = {
  executor: {
    tiers: {
      low: { model: "openai/gpt-5.6-luna" },
      medium: { model: "openai/gpt-5.6-luna" },
      high: { model: "openai/gpt-5.6-terra" },
    },
  },
  planner: { model: "openai/planner" },
  "plan-reviewer": { families: { "family-1": { model: "openai/reviewer" } } },
  compliance: { model: "openai/compliance" },
  adversary: { families: { "family-1": { model: "openai/adversary" } } },
  security: { model: "openai/security" },
  shipper: { model: "openai/shipper" },
  harvester: { model: "openai/harvester" },
};

test("projects simple and family-1 primary eye routes with the executor tiers from routing", () => {
  const result = projectExpectedModelStrategy({ roles: baseRoles });
  assert.equal(result.ok, true);
  assert.deepEqual(result.strategy.hand_tiers, {
    low: "openai/gpt-5.6-luna",
    medium: "openai/gpt-5.6-luna",
    high: "openai/gpt-5.6-terra",
  });
  assert.equal(result.strategy["plan-reviewer"], "openai/reviewer");
  assert.equal(result.strategy.adversary, "openai/adversary");
});

test("rejects malformed expected strategy projections rather than producing a partial snapshot", () => {
  const result = projectExpectedModelStrategy({ roles: { ...baseRoles, security: {} } });
  assert.equal(result.ok, false);
  assert.match(result.reason, /security/);
});

test("rejects a routing projection with a missing executor tier", () => {
  const roles = structuredClone(baseRoles);
  delete roles.executor.tiers.high;
  const result = projectExpectedModelStrategy({ roles });
  assert.equal(result.ok, false);
  assert.match(result.reason, /executor.*high/i);
});
