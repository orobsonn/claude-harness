import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);

const lanes = [
  ["Pi", "pi/runtime/agents/harness-planner.md", "pi/runtime/agents/harness-plan-reviewer.md"],
  ["Claude Code", "claude-code/skills/creating-plans/SKILL.md", "claude-code/agents/plan-reviewer.md"],
  ["Codex", "codex/skills/harness-planning/SKILL.md", "codex/agents/plan-reviewer.toml"],
  ["OpenCode", "opencode/skills/creating-plans/SKILL.md", "opencode/agents/plan-reviewer.md"],
];

function read(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, root)), "utf8");
}

function includesPolicy(prompt, pattern, message) {
  assert.ok(pattern.test(prompt), message);
}

for (const [lane, plannerPath, reviewerPath] of lanes) {
  test(`${lane} chooses test layout from project evidence before applying the new-project default`, () => {
    const planner = read(plannerPath);
    const reviewer = read(reviewerPath);

    for (const [role, prompt] of [["planner", planner], ["reviewer", reviewer]]) {
      includesPolicy(prompt, /existing tests|test files/i, `${lane} ${role}: inspect existing tests`);
      includesPolicy(prompt, /runner configuration/i, `${lane} ${role}: inspect runner configuration`);
      includesPolicy(prompt, /project instructions/i, `${lane} ${role}: inspect project instructions`);
      includesPolicy(prompt, /establish(?:ed)?[^.\n]*layout/i, `${lane} ${role}: preserve established layout`);
      includesPolicy(prompt, /do not move existing tests|without moving existing tests|never\s+move existing tests|migration to the default/i, `${lane} ${role}: no migration`);
      includesPolicy(prompt, /root `?tests\/?`?/i, `${lane} ${role}: new-project default`);
      includesPolicy(prompt, /fixtures/i, `${lane} ${role}: fixtures follow the layout`);
      includesPolicy(prompt, /first\s+task/i, `${lane} ${role}: runner discovery belongs to first test task`);
    }

    includesPolicy(reviewer, /REVISE/, `${lane} reviewer: enforce the chosen branch`);
  });
}
