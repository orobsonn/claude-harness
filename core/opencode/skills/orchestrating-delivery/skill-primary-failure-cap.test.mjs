/**
 * @description The `primary_failure_cap_reached` rule in the OC orchestrating-delivery skill must
 * name its own value and counter, and must not be readable as the neighbouring `validate-plan` cap.
 *
 * Why this exists (#540): the rule used to say "hit the streak cap" with no number. The only
 * numbered cap visible above it, in the SAME phase and a few lines away, is `validate-plan`'s
 * `Cap 2 loops` — so an orchestrator reading fast binds the streak to 2 and stops delivery one
 * failure before the real ceiling of 3. Naming the value fixes half of it; disowning the neighbour
 * by name fixes the other half, and the spec-phase exemption keeps the status from reading as
 * run-wide when the rail exempts the Phase 0 eye.
 *
 * The number is pinned to the rail (`LOOP_THRESHOLDS.primary_failure_streak.deny`) and no other
 * bare count may sit in the paragraph — a second number re-opens the ambiguity from a new angle.
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
 * Code spans, issue refs (`#482`) and structural labels (`family-1`, `Phase 0`, `step 3`,
 * `HARD-GATE 2`) carry digits that identify a thing, not a count. Everything left is prose stating
 * how many failures it takes — and that number has exactly one legitimate value.
 */
function countsOnly(paragraph) {
  return paragraph
    // A code span that is nothing but a number is still a claim about how many — stripping it
    // blindly would let a contradicting count sit in the paragraph inside backticks.
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
    "the rule must name the counter it reads — an unnamed 'streak cap' is what let it be confused " +
      "with the neighbouring `validate-plan` cap (#540).",
  );
  assert.match(
    capParagraph,
    /LOOP_THRESHOLDS\.primary_failure_streak\.deny/,
    "the rule must name the rail its number copies, so a reader knows which side wins on a disagreement.",
  );
  assert.match(
    capParagraph,
    /stale/i,
    "the rule must say the stated number is a copy that can go stale — a number in a system " +
      "instruction reads as authoritative otherwise.",
  );
});

test("OC orchestrating-delivery: the primary failure cap states the rail's number and no other count", () => {
  const deny = LOOP_THRESHOLDS.primary_failure_streak.deny;
  assert.ok(
    Number.isInteger(deny) && deny > 0,
    "LOOP_THRESHOLDS.primary_failure_streak.deny must be a positive integer for this guard to mean anything.",
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
      `the primary-failure-cap rule states the count ${value}, but the rail ` +
        `(LOOP_THRESHOLDS.primary_failure_streak.deny) is ${deny}. A second number in this ` +
        "paragraph re-opens the ambiguity it exists to close.",
    );
  }
});

test("OC orchestrating-delivery: the primary failure cap disowns the neighbouring validate-plan cap", () => {
  assert.match(
    capParagraph,
    /Cap 2 loops/,
    "the rule must name the cap it is confused with (`validate-plan`'s `Cap 2 loops`) — the " +
      "confusion is with THAT rule specifically, and a generic 'other caps' note does not resolve it.",
  );
  assert.match(
    capParagraph,
    /validate-plan/,
    "the rule must say which loop the `Cap 2 loops` belongs to.",
  );
  // The negation must be explicit, but not tied to one markdown flavour — a rewrite to *not* or
   // "never" is the same instruction and must not redden CI.
  assert.match(
    capParagraph,
    /(?:\*\*|__|\*)?\b(?:not|never)\b(?:\*\*|__|\*)?[^.]{0,30}`Cap 2 loops`/i,
    "the disavowal must be explicit — mentioning the neighbour without denying it installs the " +
      "association instead of removing it.",
  );
});

test("OC orchestrating-delivery: the primary failure cap states the spec-phase exemption", () => {
  assert.match(
    capParagraph,
    /[Ss]pec-phase exemption/,
    "the rule must state that the Phase 0 spec-adversary is exempt — otherwise the status reads as " +
      "run-wide and a broken spec eye looks like a frozen delivery.",
  );
  assert.match(
    capParagraph,
    /adversary/,
    "the exemption must name the exempt role (the spec-phase `adversary`).",
  );
  assert.match(
    capParagraph,
    /nothing is frozen|never writes this status/i,
    "the exemption must say what does NOT happen — the eye stops being re-dispatched, delivery is not frozen.",
  );

  // The behaviour this prose describes is pinned where it belongs, against the rail itself:
  // `plugin/lib/review-accounting.test.mjs` runs the full streak on a spec-phase adversary and
  // asserts no `primary_failure_cap_reached` is written. Re-asserting it here by reading
  // loop-decide.mjs as text would guard a token, not the guard — and would redden on a reflow.
});
