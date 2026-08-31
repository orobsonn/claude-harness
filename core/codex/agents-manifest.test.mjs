import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadAgents, validateAgents } from "./agents-manifest.mjs";

test("custom agent catalog has exactly one focused role per harness responsibility", () => {
  const agents = loadAgents();
  assert.deepEqual(
    agents.map((agent) => agent.name).sort(),
    ["adversary", "compliance", "executor", "harvester", "plan-reviewer", "planner", "security", "shipper", "sniper", "test-author"]
  );
  assert.deepEqual(validateAgents(agents), []);
});

test("eyes are read-only and hands are workspace-write", () => {
  const byName = Object.fromEntries(loadAgents().map((agent) => [agent.name, agent]));
  for (const name of ["planner", "plan-reviewer", "adversary", "security", "compliance", "harvester"]) {
    assert.equal(byName[name].sandbox_mode, "read-only");
  }
  for (const name of ["executor", "sniper", "test-author", "shipper"]) {
    assert.equal(byName[name].sandbox_mode, "workspace-write");
  }
});

test("each role delegates the live model choice to the vendored route resolver", () => {
  const root = new URL("./agents/", import.meta.url).pathname;
  for (const file of ["executor.toml", "sniper.toml", "planner.toml", "security.toml"]) {
    assert.doesNotMatch(readFileSync(join(root, file), "utf8"), /^model\s*=/m, `${file} must remain routeable`);
  }
});
