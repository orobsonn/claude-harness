/**
 * @description A frozen test is authored before production exists. Fidelity must
 * judge the transcription, not reject the expected initial red result.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const compliance = readFileSync(join(here, "..", "..", "agents", "compliance.md"), "utf8");

function section(source, heading) {
  const start = source.indexOf(heading);
  assert.notEqual(start, -1, `missing ${heading}`);
  const end = source.indexOf("\n## ", start + heading.length);
  return source.slice(start, end === -1 ? undefined : end);
}

test("pre-executor fidelity accepts a direct expected-red assertion and limits review to pinned transcription", () => {
  const fidelity = section(compliance, "## Fidelity-transcription mode (before executor)");
  assert.match(fidelity, /pinned assertion/i);
  assert.match(fidelity, /expected.*red|red.*expected/i);
  assert.match(fidelity, /parse|import|setup|fixture/i);
  assert.match(fidelity, /must not.*criterion|must not.*critical-class|must not.*additional coverage/i);
  assert.match(fidelity, /not.*require.*green|never.*require.*green/i);
});

test("a missing planned production module is expected red, not a broken test import", () => {
  const complianceFidelity = section(compliance, "## Fidelity-transcription mode (before executor)");
  const orchestrationFidelity = section(skill, "### Test-author fidelity transcription");

  assert.match(complianceFidelity, /missing production module.*expected red/i);
  assert.match(complianceFidelity, /production entry in task `scope_paths`/i);
  assert.match(complianceFidelity, /missing planned.*scope_paths.*not a FAIL/is);
  assert.match(complianceFidelity, /wrong.*import.*path|dependency.*missing|fixture.*missing/i);
  assert.match(orchestrationFidelity, /missing production module/i);
  assert.match(orchestrationFidelity, /scope_paths/i);
  assert.match(orchestrationFidelity, /expected red/i);
  assert.match(complianceFidelity, /directly imported.*locked test/is);
  assert.match(complianceFidelity, /transitive|post-implementation|already exists/i);
});

test("a transcription failure gets one named test-author correction, never a sniper repair", () => {
  const perTask = section(skill, "### Per-task steps (topological order via `depends_on`)");
  const fidelity = section(skill, "### Test-author fidelity transcription");
  assert.match(perTask, /initial.*one correction|one correction.*test-author/i);
  assert.doesNotMatch(perTask, /at most 2 `test-author` dispatches/i);
  assert.doesNotMatch(fidelity, /sniper-high/i);
  assert.match(fidelity, /fidelity_transcription_failed/i);
  assert.match(fidelity, /do not dispatch.*planner|no.*planner/i);
});
