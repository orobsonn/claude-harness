/**
 * @description The `primary_failure_cap_reached` rule in the OC orchestrating-delivery skill must
 * name its own value and counter, and must not be readable as the neighbouring `validate-plan` cap.
 *
 * After #585 the paragraph is single-evaluator (no family-1 vocabulary) but still explains the
 * terminal state `loop-decide.mjs` emits. The file is never deleted — it is the only thing that
 * stops the rail and the prose from diverging on this terminal.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LOOP_THRESHOLDS } from "../../plugin/lib/loop-decide.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");

/** The rule is its own markdown paragraph — one line in this file. */
const capParagraph = skill
  .split("\n")
  .find((line) => line.startsWith("**Primary failure cap (`primary_failure_cap_reached`)"));

/**
 * Code spans, issue refs (`#482`) and structural labels (`Phase 0`, `step 3`, `HARD-GATE 2`)
 * carry digits that identify a thing, not a count. Everything left is prose stating how many
 * failures it takes — and that number has exactly one legitimate value.
 */
function countsOnly(paragraph) {
  return paragraph
    .replace(/`[^`]*`/g, (span) => (/^`\s*\d+\s*`$/.test(span) ? span : " "))
    .replace(/#\d+/g, " ")
    .replace(/\bfamily-\d/gi, " ")
    .replace(/\b(?:phase|step|hard-gate)\s+\d+/gi, " ");
}

test("OC orchestrating-delivery: the primary failure cap names its value and its counter", () => {
  assert.ok(
    capParagraph,
    "SKILL.md must keep the `primary_failure_cap_reached` rule as its own paragraph.",
  );

  assert.match(
    capParagraph,
    /primary_review_failure_streak/,
    "the rule must name the counter it reads.",
  );
  assert.match(
    capParagraph,
    /LOOP_THRESHOLDS\.primary_failure_streak\.deny/,
    "the rule must name the rail its number copies.",
  );
  assert.match(
    capParagraph,
    /stale/i,
    "the rule must say the stated number is a copy that can go stale.",
  );
});

test("OC orchestrating-delivery: the primary failure cap is single-evaluator (#585 #ac-2.1)", () => {
  assert.match(
    capParagraph,
    /same primary evaluator|same primary (?:eye|role)/i,
    "after the dual cut the streak belongs to the same primary evaluator — not family-1.",
  );
  assert.doesNotMatch(
    capParagraph,
    /family-1/,
    "family-1 vocabulary must not remain in the primary-failure-cap paragraph.",
  );
  assert.doesNotMatch(
    capParagraph,
    /Axis 2|Axis 1/,
    "Axis vocabulary must not remain in the primary-failure-cap paragraph.",
  );
});

test("OC orchestrating-delivery: the primary failure cap states the rail's number and no other count", () => {
  const deny = LOOP_THRESHOLDS.primary_failure_streak.deny;
  assert.ok(
    Number.isInteger(deny) && deny > 0,
    "LOOP_THRESHOLDS.primary_failure_streak.deny must be a positive integer.",
  );

  const prose = countsOnly(capParagraph);

  const stated = [...prose.matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
  assert.notEqual(
    stated.length,
    0,
    "the rule must state the streak value — 'hit the streak cap' with no number is the #540 defect.",
  );
  for (const value of stated) {
    assert.equal(
      value,
      deny,
      `the primary-failure-cap rule states the count ${value}, but the rail is ${deny}.`,
    );
  }
});

test("OC orchestrating-delivery: the primary failure cap disowns the neighbouring validate-plan cap", () => {
  assert.match(
    capParagraph,
    /Cap 2 loops/,
    "the rule must name the cap it is confused with (`validate-plan`'s `Cap 2 loops`).",
  );
  assert.match(
    capParagraph,
    /validate-plan/,
    "the rule must say which loop the `Cap 2 loops` belongs to.",
  );
  assert.match(
    capParagraph,
    /(?:\*\*|__|\*)?\b(?:not|never)\b(?:\*\*|__|\*)?[^.]{0,30}`Cap 2 loops`/i,
    "the disavowal must be explicit.",
  );
});

test("OC orchestrating-delivery: the primary failure cap states the spec-phase exemption", () => {
  assert.match(
    capParagraph,
    /[Ss]pec-phase exemption/,
    "the rule must state that the Phase 0 spec-adversary is exempt.",
  );
  assert.match(
    capParagraph,
    /adversary/,
    "the exemption must name the exempt role (the spec-phase `adversary`).",
  );
  assert.match(
    capParagraph,
    /nothing is frozen|never writes this status/i,
    "the exemption must say what does NOT happen.",
  );
});
