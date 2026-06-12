#!/usr/bin/env node
/**
 * @description Contract shape tests for the split model_strategy (hands/eyes split).
 * Verifies that example-plan.json adopts the split shape with hand_tiers (Ollama)
 * and fixed eye roles (Claude aliases), and validates validate-plan.mjs accepts it.
 * Tests run under node:test.
 */

import { test } from "node:test";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { strict as assert } from "node:assert";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the test dir
const examplePlanPath = resolve(__dirname, "../skills/creating-plans/references/example-plan.json");
const validatePlanScript = resolve(__dirname, "../skills/creating-plans/references/validate-plan.mjs");
const skillMdPath = resolve(__dirname, "../skills/creating-plans/SKILL.md");

/**
 * Test 1: Given example-plan.json, when validate-plan.mjs runs against it,
 * it prints 'OK' AND the parsed file has model_strategy.hand_tiers with
 * low/medium/high AND has NO model_strategy.eye_tiers key AND NO legacy
 * model_strategy.tiers key.
 */
test("example-plan.json: contract shape (hand_tiers, no eye_tiers, no tiers)", () => {
  // Run validate-plan.mjs and expect exit 0 + "OK"
  let output;
  let exitCode = 0;
  try {
    output = execSync(`node ${validatePlanScript} ${examplePlanPath}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    exitCode = err.status ?? 1;
    // Re-throw so test fails clearly
    throw new Error(
      `validate-plan.mjs exited ${exitCode}: ${err.stderr ?? err.message}`
    );
  }

  // Output must contain "OK"
  assert(output.includes("OK"), `Expected "OK" in output, got: ${output}`);

  // Parse the example plan and verify shape
  const planRaw = readFileSync(examplePlanPath, "utf8");
  const plan = JSON.parse(planRaw);

  // Must have model_strategy
  assert(
    plan.model_strategy,
    "example-plan.json must have model_strategy object"
  );

  // Must have hand_tiers with low/medium/high
  assert(
    plan.model_strategy.hand_tiers,
    "model_strategy must have hand_tiers object"
  );
  assert(
    plan.model_strategy.hand_tiers.low,
    "hand_tiers.low is required"
  );
  assert(
    plan.model_strategy.hand_tiers.medium,
    "hand_tiers.medium is required"
  );
  assert(
    plan.model_strategy.hand_tiers.high,
    "hand_tiers.high is required"
  );

  // Must NOT have eye_tiers
  assert(
    !plan.model_strategy.eye_tiers,
    "model_strategy must NOT have eye_tiers key"
  );

  // Must NOT have legacy tiers
  assert(
    !plan.model_strategy.tiers,
    "model_strategy must NOT have legacy tiers key"
  );

  // Verify 7 fixed eye roles are present (as Claude aliases)
  const FIXED_ROLES = [
    "planner",
    "plan-reviewer",
    "compliance",
    "adversary",
    "security",
    "shipper",
    "harvester",
  ];
  const CLAUDE_ALIASES = ["haiku", "sonnet", "opus", "fable"];
  for (const role of FIXED_ROLES) {
    assert(
      plan.model_strategy[role],
      `model_strategy.${role} is required`
    );
    assert(
      CLAUDE_ALIASES.includes(plan.model_strategy[role]),
      `model_strategy.${role} must be a Claude alias, got: ${plan.model_strategy[role]}`
    );
  }

  // Must NOT have executor or sniper keys
  assert(
    !plan.model_strategy.executor,
    "model_strategy must NOT have executor key (hand role)"
  );
  assert(
    !plan.model_strategy.sniper,
    "model_strategy must NOT have sniper key (hand role)"
  );
});

/**
 * Test 2: Given creating-plans/SKILL.md, when parsed, the model_strategy
 * section states executor and sniper resolve from hand_tiers (Ollama) while
 * every fixed eye role is a Claude alias, and contains the explicit rule
 * that no eye may resolve to an Ollama model.
 */
test("SKILL.md: documents split shape with explicit eye/hand rule", () => {
  const skillMd = readFileSync(skillMdPath, "utf8");

  // Must mention "hand_tiers" in the context of executor/sniper
  assert(
    skillMd.includes("hand_tiers"),
    "SKILL.md must mention hand_tiers"
  );

  // Must state executor resolves from hand_tiers
  assert(
    skillMd.includes("executor") && skillMd.includes("hand_tiers"),
    "SKILL.md must state executor resolves from hand_tiers"
  );

  // Must state sniper resolves from hand_tiers
  assert(
    skillMd.includes("sniper") && skillMd.includes("hand_tiers"),
    "SKILL.md must state sniper resolves from hand_tiers"
  );

  // Must state that 7 fixed eye roles are Claude aliases
  // Looking for explicit statement about the 7 roles (or at least "eye roles", "fixed roles")
  assert(
    (skillMd.includes("fixed eye role") ||
      skillMd.includes("fixed roles") ||
      skillMd.includes("eye role")) &&
      skillMd.includes("Claude"),
    "SKILL.md must state that fixed eye roles are Claude aliases"
  );

  // Must contain explicit rule that NO eye may resolve to an Ollama model
  assert(
    skillMd.includes("eye") &&
      skillMd.includes("never") &&
      (skillMd.includes("Ollama") || skillMd.includes("non-Claude")),
    "SKILL.md must contain explicit rule that no eye may resolve to non-Claude/Ollama model"
  );
});
