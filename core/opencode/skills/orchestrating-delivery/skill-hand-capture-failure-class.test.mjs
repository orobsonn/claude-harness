/**
 * @description A `mark` `ok:false` on a non-DONE hand-record must be split by CAUSE in the OC
 * orchestrating-delivery skill: transient dispatch failure retries under the same-agent K=3, a hand
 * that ran and refused (`BLOCKED` / `NEEDS_CONTEXT` / `CONFIG_ERROR`) goes straight to CRITICAL
 * EXCEPTION with no retry.
 *
 * Why this exists (#558): § Post-hand capture path step 2 used to order a retry for every
 * `ok:false`. Step 1 only auto-stamps on a DONE outcome, so "record is not DONE" also covers the
 * hand that ran and refused — and for that class the same file says the opposite twice (§ Per-task
 * steps step b and "Hand CONFIG_ERROR → critical exception"). The retry order was the most emphatic
 * and the closest to the decision point, so it won: three dispatches of a hand that should have gone
 * straight to critical exception. The § Escalation ladder had to answer the same question from its
 * own side — its trigger is `on provider/transient Task failure`, and it never said whether a
 * never-DONE capture record is inside it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const lines = skill.split("\n");

/**
 * Step 2 of § Post-hand capture path — the numbered item plus every sub-bullet indented under it,
 * up to the next top-level numbered item.
 * @returns {string} The step-2 block.
 */
function captureStepTwo() {
  const start = lines.findIndex((line) => /^2\. Still call native `mark`/.test(line));
  assert.notEqual(
    start,
    -1,
    "SKILL.md must keep § Post-hand capture path step 2 as the `mark` belt-call item.",
  );
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\d+\. /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

/**
 * The § Escalation ladder section, heading to next heading of the same or higher level.
 * @returns {string} The section text.
 */
function escalationLadder() {
  const start = lines.findIndex((line) => /^### Escalation ladder/.test(line));
  assert.notEqual(start, -1, "SKILL.md must keep the § Escalation ladder section.");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

const stepTwo = captureStepTwo();
const ladder = escalationLadder();

/** The three read-backs that mean the hand ran and refused. */
const REFUSAL_VERDICTS = ["BLOCKED", "NEEDS_CONTEXT", "CONFIG_ERROR"];

test("#ac-1.1 — capture step 2 splits `ok:false` into two causes instead of one retry order", () => {
  assert.match(
    stepTwo,
    /transient/i,
    "step 2 must name the transient branch — the cause that legitimately retries.",
  );
  assert.match(
    stepTwo,
    /refus|ran and|did not deliver/i,
    "step 2 must name the other cause: the hand that ran and finished without delivering.",
  );

  // The defect was a single unconditional instruction. Whatever the markdown shape, the two causes
  // have to be readable as separate branches with separate outlets.
  const bullets = stepTwo
    .split("\n")
    .filter((line) => /^\s+- /.test(line));
  assert.ok(
    bullets.length >= 2,
    "step 2 must present the causes as distinct branches — a single paragraph is what let the " +
      "retry order swallow the refusal class (#558).",
  );
});

test("#ac-1.1 — the refusal branch routes to CRITICAL EXCEPTION and forbids the re-dispatch", () => {
  const refusal = stepTwo
    .split("\n")
    .find((line) => REFUSAL_VERDICTS.every((verdict) => line.includes(verdict)));
  assert.ok(
    refusal,
    "step 2 must carry one branch naming all three refusal read-backs " +
      `(${REFUSAL_VERDICTS.join(", ")}) — the class that must never be re-dispatched.`,
  );

  assert.match(
    refusal,
    /CRITICAL EXCEPTION/,
    "the refusal branch must state its outlet explicitly; 'do not retry' alone leaves the " +
      "orchestrator with no next move.",
  );
  assert.match(
    refusal,
    /\b(?:no retry|not\b[^.]{0,40}\bre-?dispatch|never\b[^.]{0,40}\bre-?dispatch|do not retry)/i,
    "the refusal branch must forbid the re-dispatch in words — naming the outlet without denying " +
      "the retry leaves the two rules in force at once, which is the #558 defect.",
  );
});

test("#ac-1.1 — the refusal branch agrees with the two rules that already govern this class", () => {
  const refusal = stepTwo
    .split("\n")
    .find((line) => REFUSAL_VERDICTS.every((verdict) => line.includes(verdict)));

  assert.match(
    refusal,
    /Per-task steps/,
    "the refusal branch must point at § Per-task steps step b by SECTION NAME — the contradicting " +
      "rule is there, and line numbers drift (#556).",
  );
  assert.match(
    refusal,
    /Hand CONFIG_ERROR/,
    "the refusal branch must point at the § Escalation ladder rule 'Hand CONFIG_ERROR → critical " +
      "exception', the other rule this step used to contradict.",
  );
  assert.doesNotMatch(
    refusal,
    /:\d{2,}/,
    "cross-references must be by section name, never by line number (#556).",
  );
});

test("#ac-1.1 — the transient branch keeps the same-agent K=3 budget", () => {
  const transient = stepTwo
    .split("\n")
    .find((line) => /^\s+- /.test(line) && /transient/i.test(line) && /K=3/.test(line));
  assert.ok(
    transient,
    "step 2 must keep a branch granting the same-agent K=3 to a genuinely transient failure — " +
      "#uj-2 says that hand still gets its 3 attempts.",
  );

  assert.match(
    transient,
    /Escalation ladder/,
    "the transient branch must keep naming § Escalation ladder as the budget's home (#538).",
  );
  assert.match(
    transient,
    /existing/i,
    "the transient branch must keep saying the counter is the role's EXISTING one, not a fresh 3 (#538).",
  );
  assert.ok(
    !REFUSAL_VERDICTS.some((verdict) => transient.includes(verdict)),
    "the transient branch must not claim the refusal verdicts — that merge is the defect.",
  );
});

test("#ac-1.1 — step 2 says how to tell the causes apart", () => {
  assert.match(
    stepTwo,
    /read-?back/i,
    "step 2 must say what evidence distinguishes a refusal from a broken dispatch; without a " +
      "tie-break the orchestrator picks a branch by feel.",
  );
  assert.match(
    stepTwo,
    /(?:never infer|not\b[^.]{0,40}\bfrom the (?:non-DONE )?record alone|record's state)/i,
    "step 2 must deny the record's state as the discriminator — the cause decides, and the record " +
      "is non-DONE in both branches.",
  );
});

test("#ac-2.1 — the Escalation ladder declares whether a never-DONE capture record is in its trigger", () => {
  const declaration = ladder
    .split("\n")
    .find((line) => /capture record/i.test(line) && /DONE/.test(line));
  assert.ok(
    declaration,
    "§ Escalation ladder must answer, on its own side, whether 'the capture record never reached " +
      "DONE' falls under `on provider/transient Task failure` — leaving it implicit at the point of " +
      "use is the #558 defect.",
  );

  assert.match(
    declaration,
    /\binside\b/i,
    "the declaration must say when the class IS inside the trigger.",
  );
  assert.match(
    declaration,
    /\boutside\b/i,
    "the declaration must say when the class is NOT inside the trigger — half an answer still lets " +
      "the retry rule capture a refusal.",
  );
  assert.match(
    declaration,
    /provider\/transient/,
    "the declaration must quote the trigger it is ruling on.",
  );
});

test("#ac-2.1 — the ladder's declaration keys on the cause, not on the record's state", () => {
  const declaration = ladder
    .split("\n")
    .find((line) => /capture record/i.test(line) && /DONE/.test(line));

  for (const verdict of REFUSAL_VERDICTS) {
    assert.ok(
      declaration.includes(verdict),
      `the declaration must name ${verdict} as an excluded cause — the exclusion is per verdict, ` +
        "and an unnamed one reads as still retryable.",
    );
  }
  assert.match(
    declaration,
    /CRITICAL EXCEPTION/,
    "the excluded branch must name where it goes instead of this axis.",
  );
  assert.match(
    declaration,
    /Post-hand capture path/,
    "the declaration must reference the point of use by SECTION NAME, so the two sides stay linked " +
      "when lines drift (#556).",
  );
  assert.doesNotMatch(
    declaration,
    /:\d{2,}/,
    "cross-references must be by section name, never by line number (#556).",
  );
});
