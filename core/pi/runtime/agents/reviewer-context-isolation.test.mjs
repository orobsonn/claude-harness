import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createJiti } from "../../../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti-static.mjs";

const PACKAGE_ROOT = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const REVIEW_ROLES = [
  "harness-adversary",
  "harness-discussion-adversary",
  "harness-plan-reviewer",
  "harness-test-reviewer",
  "harness-compliance",
  "harness-security",
];

test("native child prompt discards the parent's transient project memory tail", async () => {
  const jiti = createJiti(import.meta.url, { moduleCache: false, tsconfigPaths: true });
  const { buildAgentPrompt } = await jiti.import(resolve(PACKAGE_ROOT, "node_modules/@gotgenes/pi-subagents/src/session/prompts.ts"));
  const inherited = { cwd: "/fixture", systemPrompt: "Base identity\nCurrent working directory: /fixture\n<project-memory-data>MEMORY_PARENT_ONLY_SENTINEL</project-memory-data>" };
  for (const role of REVIEW_ROLES) {
    const prompt = buildAgentPrompt({ name: role, promptMode: "replace", systemPrompt: "Review current evidence independently." }, "/fixture", { isGitRepo: true, branch: "feature", platform: "linux" }, inherited);
    assert.match(prompt, /Base identity/);
    assert.doesNotMatch(prompt, /MEMORY_PARENT_ONLY_SENTINEL|project-memory-data/);
  }
});

test("reviewer agent definitions lock fresh context in the real subagent resolver", async (t) => {
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
  const agents = loadCustomAgents(resolve(PACKAGE_ROOT, ".missing-reviewer-fixture"));

  for (const role of REVIEW_ROLES) {
    const agent = agents.get(role);
    assert.ok(agent, `${role} must load through the real subagent agent loader`);
    assert.equal(agent.inheritContext, false, `${role} must declare fresh context`);
    assert.equal(agent.locked, true, `${role} must lock its declared context policy`);
    const resolved = resolveAgentInvocationConfig(agent, { inherit_context: true });
    assert.equal(resolved.inheritContext, false, `${role} must keep fresh context when a caller requests inheritance`);
    assert.equal(resolved.discarded.includes("inherit_context"), true, `${role} must report the locked override as discarded`);
  }
});
