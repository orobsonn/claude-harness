/**
 * @description Locks the post-APPROVE boundary found in the vps-gestao run:
 * engineering evidence must not silently buy a new planning/review cycle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

function section(heading) {
  const start = skill.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const end = skill.indexOf("\n## ", start + heading.length);
  return skill.slice(start, end === -1 ? undefined : end);
}

test("approved plan keeps same-contract engineering out of a new planner cycle", () => {
  const continuity = section("## Approved-plan continuity");
  assert.match(continuity, /plan-reviewer.*APPROVE/i);
  assert.match(continuity, /do not dispatch.*planner.*plan-reviewer|do not dispatch.*plan-reviewer.*planner/i);
  assert.match(continuity, /shared_context.*does not grant.*write/i);
  assert.match(continuity, /current task.*scope_paths/i);
  assert.match(continuity, /pending task.*scope_paths/i);
});

test("out-of-scope evidence is classified without silently expanding the approved plan", () => {
  const continuity = section("## Approved-plan continuity");
  assert.match(continuity, /outside.*scope_paths.*open risk|open risk.*outside.*scope_paths/i);
  assert.match(continuity, /plan-contract conflict/i);
  assert.match(continuity, /material.*security|security.*material/i);
  assert.match(continuity, /do not write outside/i);
  assert.match(continuity, /do not auto(?:matically)? re-plan/i);
});
