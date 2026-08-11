/**
 * @description Resume markers attest to a prior hand, not to an immutable
 * working tree. When a normal task gate proves a captured predecessor is absent
 * from this checkout, the conductor must repair the approved DAG instead of
 * spending another plan review or stopping for an engineering decision.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

test("resume checkout contradiction recovers the approved dependency closure without replanning", () => {
  assert.match(skill, /Resume checkout recovery/i);
  assert.match(skill, /objective.*proof|proof.*objective/i);
  assert.match(skill, /scope_paths/i);
  assert.match(skill, /transitive dependents/i);
  assert.match(skill, /topological order/i);
  assert.match(skill, /do not dispatch planner.*plan-reviewer|do not dispatch plan-reviewer.*planner/i);
  assert.match(skill, /same approved plan/i);
});

test("resume checkout recovery preserves frozen proof and stops only for a real conflict or repeated failed proof", () => {
  assert.match(skill, /locked test.*exists.*do not rewrite|do not rewrite.*locked test.*exists/i);
  assert.match(skill, /external.*diff|foreign.*diff/i);
  assert.match(skill, /same proof.*fails again|fails again.*same proof/i);
});
