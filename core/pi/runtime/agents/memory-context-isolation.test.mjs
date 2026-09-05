import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "../../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const MEMORY_SCOPED_ROLES = [
  "harness-planner",
  "harness-executor",
  "harness-test-author",
  "harness-sniper",
  "harness-harvester",
  "harness-shipper",
];

test("memory-scoped roles lock fresh context so briefs stay selective", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = resolve(PACKAGE_ROOT, "core/pi/runtime");
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
  const { loadCustomAgents } = await jiti.import(
    resolve(PACKAGE_ROOT, "node_modules/@gotgenes/pi-subagents/src/config/custom-agents.ts"),
  );
  const { resolveAgentInvocationConfig } = await jiti.import(
    resolve(PACKAGE_ROOT, "node_modules/@gotgenes/pi-subagents/src/config/invocation-config.ts"),
  );
  const agents = loadCustomAgents(resolve(PACKAGE_ROOT, ".missing-memory-fixture"));

  for (const role of MEMORY_SCOPED_ROLES) {
    const agent = agents.get(role);
    assert.ok(agent, `${role} must load through the real subagent agent loader`);
    assert.equal(agent.inheritContext, false, `${role} must declare fresh context`);
    assert.equal(agent.locked, true, `${role} must lock its declared context policy`);
    const resolved = resolveAgentInvocationConfig(agent, { inherit_context: true });
    assert.equal(resolved.inheritContext, false, `${role} must keep fresh context when inheritance is requested`);
    assert.equal(resolved.discarded.includes("inherit_context"), true, `${role} must report the override as discarded`);
  }
});
