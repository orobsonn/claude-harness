/**
 * @description A resumed feature can briefly surface a stale planner failure while
 * its canonical APPROVE binding is restored.  The host then rejects a planner
 * dispatch on purpose; the conductor must keep the same session moving on the
 * approved plan rather than buying another planning/review cycle.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const build = readFileSync(join(here, "..", "..", "agents", "build.md"), "utf8");

test("resumed approved-plan refusal continues the same delivery without a new planning cycle", () => {
  for (const document of [skill, build]) {
    assert.match(document, /resumed approved plan must continue delivery/i);
    assert.match(document, /same session/i);
    assert.match(document, /do not dispatch .*planner.*plan-reviewer|do not dispatch .*plan-reviewer.*planner/i);
    assert.match(document, /next legal unfinished task/i);
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
