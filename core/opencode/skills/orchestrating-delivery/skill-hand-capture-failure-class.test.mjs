/**
 * @description A `mark` `ok:false` on a hand-record that is not DONE must be split by CAUSE in the OC
 * orchestrating-delivery skill: a transient dispatch failure retries under the same-agent K=3, a hand
 * that ran and refused (`BLOCKED` / `NEEDS_CONTEXT`) or was denied before it ran (`CONFIG_ERROR`)
 * goes straight to CRITICAL EXCEPTION with no retry, and a `DONE_WITH_CONCERNS` record — non-DONE
 * with nothing having failed — is neither.
 *
 * After #585 the Post-hand capture path is collapsed to one cause-split (no Axis vocabulary), but
 * the three outlets remain load-bearing.
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
 */
function captureStepTwoLines() {
  const start = lines.findIndex((line) => /^2\. .*`mark`/.test(line));
  assert.notEqual(
    start,
    -1,
    "SKILL.md must keep § Post-hand capture path step 2 as the `mark` belt-call item.",
  );
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^\d+\. /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))];
}

/**
 * The § Escalation ladder section, heading to next heading of the same or higher level.
 */
function escalationLadderLines() {
  const start = lines.findIndex((line) => /^### Escalation ladder/.test(line));
  assert.notEqual(start, -1, "SKILL.md must keep the § Escalation ladder section.");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))];
}

/**
 * Group a block into bullets: each `- ` line joined with the continuation lines under it.
 */
function bullets(blockLines) {
  const grouped = [];
  for (const line of blockLines) {
    if (/^\s*- /.test(line)) grouped.push(line);
    else if (grouped.length && line.trim()) grouped[grouped.length - 1] += ` ${line.trim()}`;
  }
  return grouped;
}

const stepTwoLines = captureStepTwoLines();
const stepTwo = stepTwoLines.join("\n");
const stepTwoHeader = stepTwoLines[0];
const stepTwoBullets = bullets(stepTwoLines);
const ladderBullets = bullets(escalationLadderLines());
const ladderText = escalationLadderLines().join("\n");

/** The read-backs that mean the hand never delivered by its own verdict. */
const REFUSAL_VERDICTS = ["BLOCKED", "NEEDS_CONTEXT", "CONFIG_ERROR"];

/** Bullets that speak for the whole refusal class. */
const refusalBullets = stepTwoBullets.filter((bullet) =>
  REFUSAL_VERDICTS.every((verdict) => bullet.includes(verdict)),
);

test("#ac-1.1 — capture step 2 splits `ok:false` into causes instead of one retry order", () => {
  assert.ok(
    stepTwoBullets.length >= 2,
    "step 2 must present the causes as distinct branches.",
  );
  assert.match(stepTwo, /transient/i, "step 2 must name the transient branch.");
  assert.match(stepTwo, /refus|deliver/i, "step 2 must name the hand that ran without delivering.");
});

test("#ac-1.1 — step 2's own line carries no unconditional retry order", () => {
  assert.doesNotMatch(
    stepTwoHeader,
    /(?:re-?dispatch|retry)[^.]{0,40}\bhand\b|treat as hand failure/i,
    "the retry order may live ONLY on the transient branch.",
  );
  assert.doesNotMatch(
    stepTwoHeader,
    /\balways\b/i,
    "the step's line must not make a blanket claim about what `ok:false` means.",
  );
});

test("#ac-1.1 — every bullet naming the refusal class routes to CRITICAL EXCEPTION, no retry", () => {
  assert.ok(
    refusalBullets.length >= 1,
    "step 2 must carry a branch naming all three non-delivering read-backs.",
  );

  for (const bullet of refusalBullets) {
    assert.match(bullet, /CRITICAL EXCEPTION/, "refusal class must state its outlet.");
    assert.match(
      bullet,
      /\b(?:no retry|not\b[^.]{0,40}\bre-?dispatch|never\b[^.]{0,40}\bre-?dispatch|do not retry)/i,
      "the refusal class must have the re-dispatch forbidden in words.",
    );
  }
});

test("#ac-1.1 — the refusal branch agrees with the two rules that already govern this class", () => {
  const branch = refusalBullets.find((bullet) => /Per-task steps/.test(bullet));
  assert.ok(
    branch,
    "the refusal branch must point at § Per-task steps step b by SECTION NAME.",
  );
  assert.match(
    branch,
    /Hand CONFIG_ERROR/,
    "the refusal branch must point at the § Escalation ladder rule 'Hand CONFIG_ERROR'.",
  );
  assert.doesNotMatch(branch, /:\d{2,}/, "cross-references must be by section name, never line number.");
});

test("#ac-1.1 — the transient branch keeps the same-agent K=3 budget", () => {
  const branch = stepTwoBullets.find(
    (bullet) => /transient/i.test(bullet) && /K=3/.test(bullet),
  );
  assert.ok(
    branch,
    "step 2 must keep a branch granting the same-agent K=3 to a genuinely transient failure.",
  );

  assert.match(branch, /Escalation ladder/, "transient branch must name § Escalation ladder.");
  assert.match(branch, /existing/i, "transient branch must say the counter is the role's EXISTING one.");
  assert.ok(
    !REFUSAL_VERDICTS.some((verdict) => branch.includes(verdict)),
    "the transient branch must not claim the refusal verdicts.",
  );
});

test("#ac-1.1 — a `DONE_WITH_CONCERNS` record is routed, not left in the gap the split opened", () => {
  const branch = stepTwoBullets.find((bullet) => bullet.includes("DONE_WITH_CONCERNS"));
  assert.ok(branch, "`DONE_WITH_CONCERNS` must have an explicit outlet.");

  assert.match(
    branch,
    /\b(?:not|never)\b[^.]{0,40}\bre-?dispatch/i,
    "a hand that delivered with reservations must not be re-dispatched.",
  );
  assert.match(
    branch,
    /tier|escalation ladder|compliance/i,
    "the concern's verdict belongs to the tier-escalation path / compliance+gates.",
  );
});

test("#ac-1.1 — step 2 says how to tell the causes apart, including the pre-dispatch deny", () => {
  const tieBreak = stepTwoBullets.find(
    (bullet) =>
      /read-?back/i.test(bullet) &&
      /absen(?:ce|t)|no read-?back|without a read-?back/i.test(bullet),
  );
  assert.ok(
    tieBreak,
    "step 2 must say what evidence distinguishes the causes when there is no read-back.",
  );

  assert.match(
    tieBreak,
    /entry-gate|pre-?dispatch|denied/i,
    "the tie-break must exempt the dispatch the harness itself refused before it ran.",
  );
  assert.match(tieBreak, /CONFIG_ERROR/, "the tie-break must name the CONFIG_ERROR verdict.");
  assert.match(
    tieBreak,
    /missing or unreadable/,
    "the tie-break must name the distinguishing `mark` reason.",
  );
  assert.match(
    stepTwo,
    /(?:never infer|record's state alone)/i,
    "step 2 must deny the record's state as the discriminator.",
  );
});

test("#ac-1.1 — the refusal is read off the Task read-back, not off the record", () => {
  const branch = refusalBullets.find((bullet) => /Per-task steps/.test(bullet));
  assert.match(branch, /read-?back/i, "refusal branch must name the Task read-back.");
  assert.match(
    branch,
    /promote[sd]?\b[^.]{0,60}DONE|never records `?CONFIG_ERROR|record can hide/i,
    "the branch must warn that the record is not a second source.",
  );
});

test("#ac-2.1 — the Escalation ladder declares whether a never-DONE capture record is in its trigger", () => {
  const declaration = ladderBullets.find(
    (bullet) => /capture record/i.test(bullet) && /DONE/.test(bullet),
  );
  assert.ok(
    declaration,
    "§ Escalation ladder must answer whether 'the capture record never reached DONE' is inside " +
      "provider/transient failure.",
  );

  assert.match(declaration, /\binside\b/i, "must say when the class IS inside the trigger.");
  assert.match(declaration, /\boutside\b/i, "must say when the class is NOT inside the trigger.");
  assert.match(declaration, /provider\/transient/, "must quote the trigger it is ruling on.");
});

test("#ac-2.1 — the ladder's declaration keys on the cause, not on the record's state", () => {
  const declaration = ladderBullets.find(
    (bullet) => /capture record/i.test(bullet) && /DONE/.test(bullet),
  );

  for (const verdict of REFUSAL_VERDICTS) {
    assert.ok(
      declaration.includes(verdict),
      `the declaration must name ${verdict} as an excluded cause.`,
    );
  }
  assert.match(declaration, /CRITICAL EXCEPTION/, "excluded branch must name where it goes.");
  assert.match(
    declaration,
    /Post-hand capture path/,
    "declaration must reference the point of use by SECTION NAME.",
  );
  assert.doesNotMatch(declaration, /:\d{2,}/, "cross-references must be by section name.");
});

test("#ac-2.1 — escalation ladder has no Axis vocabulary (#585)", () => {
  assert.doesNotMatch(ladderText, /\bAxis 1\b|\bAxis 2\b/, "Axis naming is dual-lane vocabulary.");
  assert.match(
    ladderText,
    /one tier up|one tier above/i,
    "ladder must state the CC form: one tier up, once.",
  );
});
