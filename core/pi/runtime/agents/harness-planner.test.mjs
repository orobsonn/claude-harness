import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const plannerPath = fileURLToPath(new URL("./harness-planner.md", import.meta.url));

test("planner Pi recebe o mesmo contrato estrutural de plano validado da lane OpenCode", () => {
  const prompt = readFileSync(plannerPath, "utf8");

  assert.match(prompt, /full planning contract/i);
  assert.match(prompt, /Execution-plan schema/);
  assert.match(prompt, /"model_strategy"/);
  assert.match(prompt, /"severity"/);
  assert.match(prompt, /"scope_paths"/);
  assert.match(prompt, /"criterion_refs"/);
  assert.match(prompt, /"locked_tests"/);
  assert.match(prompt, /"adversarial"/);
  assert.match(prompt, /Self-check/);
  assert.match(prompt, /validate-plan/);
});
