/**
 * @description An approved plan is the normal delivery contract, but a concrete
 * in-flow contradiction may require a minimal revision in the same session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const build = readFileSync(join(here, "..", "..", "agents", "build.md"), "utf8");

test("an approved plan defaults to delivery and reserves planner revision for a concrete contradiction", () => {
  for (const document of [skill, build]) {
    assert.match(document, /same session/i);
    assert.match(document, /concrete.*(?:locked test|gate|executor|compliance|security)/i);
    assert.match(document, /minimum.*revision/i);
    assert.match(document, /product behavior.*contract/i);
  }
});

test("ordinary plan refusals still use the planner repair rail", () => {
  assert.match(skill, /If the Task metadata says the plan was refused, fix it \*\*with the planner\*\*/i);
});

test("a resumed legacy binding gets one reviewer before any planner repair", () => {
  for (const document of [skill, build]) {
    assert.match(document, /resumed bound plan awaits plan review/i);
  }
  assert.match(skill, /resume-bound-plan-review/i);
  assert.match(skill, /do \*\*not\*\* .*validate-plan.*current routing/i);
  assert.match(skill, /APPROVE.*next legal unfinished task.*REVISE.*planner/i);
});
