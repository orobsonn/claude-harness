/**
 * @description The plan-review budget prose in the OC orchestrating-delivery skill keeps a number
 * for clarity — so it must carry the staleness note, and no OTHER number may sit beside it.
 *
 * Why this exists (#536): the skill states the budget in rounds. `skills-alignment.test.mjs`
 * (#529) already pins that number to `LOOP_THRESHOLDS.plan_review.deny`, so it cannot silently
 * diverge from the rail. What it does not cover is the other half of the requirement: a reader
 * who sees a number in a system instruction has no way to know it is a copy unless the prose says
 * so, and a SECOND number in the same paragraph re-opens the ambiguity from a different angle.
 *
 * The number sweep is vocabulary-independent on purpose: enumerating phrasings ("N useful
 * rounds", "N revision loops", …) is exactly how a reintroduction slips through in wording nobody
 * listed. Every bare number in the paragraph must be the rail's, or it does not belong there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LOOP_THRESHOLDS } from "../../plugin/lib/loop-decide.mjs";

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "SKILL.md");
const skill = readFileSync(skillPath, "utf8");

/** The step-4 paragraph is where the plan-review loop and its budget are described. */
const budgetParagraph = skill
  .split("\n")
  .find((line) => line.includes("The budget is enforced by the gate"));

/**
 * The markdown list marker, code spans (`plan-reviewer-family-1`, `revise_nudge`) and issue refs
 * (`#483`) carry digits that are ordinals or identifiers, not round counts. Everything left is
 * prose making a claim.
 */
function proseOnly(paragraph) {
  return paragraph
    .replace(/^\s*\d+\.\s+/, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/#\d+/g, " ");
}

/** Spelled-out round counts — the digit sweep alone would not see "three revision loops". */
const SPELLED_ROUND_COUNT =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:[a-z-]+\s+){0,2}(?:rounds?|loops?)\b/i;

test("OC orchestrating-delivery skill: the plan-review budget number is marked as a copy of the rail", () => {
  assert.ok(
    budgetParagraph,
    "SKILL.md must keep a paragraph stating that the plan-review budget is enforced by the gate.",
  );
  assert.match(
    budgetParagraph,
    /revise_nudge/,
    "the plan-review budget paragraph must point the orchestrator at `revise_nudge` for the round and the rounds remaining.",
  );
  assert.match(
    budgetParagraph,
    /LOOP_THRESHOLDS\.plan_review\.deny/,
    "the paragraph must name `LOOP_THRESHOLDS.plan_review.deny` as the rail the stated number copies — " +
      "a number in a system instruction reads as authoritative unless the prose says it is a copy.",
  );
  assert.match(
    budgetParagraph,
    /stale/i,
    "the paragraph must say the stated number can go stale, so a reader who finds a disagreement knows which side wins.",
  );
});

test("OC orchestrating-delivery skill: the budget paragraph carries no number other than the rail's", () => {
  const deny = LOOP_THRESHOLDS.plan_review.deny;
  assert.ok(
    Number.isInteger(deny) && deny > 0,
    "LOOP_THRESHOLDS.plan_review.deny must be a positive integer for this guard to mean anything.",
  );

  const prose = proseOnly(budgetParagraph);

  for (const match of prose.matchAll(/\b(\d+)\b/g)) {
    assert.equal(
      Number(match[1]),
      deny,
      `the plan-review budget paragraph states the number ${match[1]}, but the rail ` +
        `(LOOP_THRESHOLDS.plan_review.deny) is ${deny}. A second number here re-opens the ` +
        "ambiguity this paragraph exists to close — drop it and defer to `revise_nudge`.",
    );
  }

  const spelled = prose.match(SPELLED_ROUND_COUNT);
  assert.equal(
    spelled,
    null,
    `the plan-review budget paragraph spells out a round count ("${spelled?.[0]}"). A count written ` +
      "in words drifts from the rail exactly like a digit does — defer to `revise_nudge` instead.",
  );
});
