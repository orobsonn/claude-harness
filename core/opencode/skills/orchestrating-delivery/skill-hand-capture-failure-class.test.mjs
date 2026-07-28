/**
 * @description A `mark` `ok:false` on a hand-record that is not DONE must be split by CAUSE in the OC
 * orchestrating-delivery skill: a transient dispatch failure retries under the same-agent K=3, a hand
 * that ran and refused (`BLOCKED` / `NEEDS_CONTEXT`) or was denied before it ran (`CONFIG_ERROR`)
 * goes straight to CRITICAL EXCEPTION with no retry, and a `DONE_WITH_CONCERNS` record — non-DONE
 * with nothing having failed — is neither.
 *
 * Why this exists (#558): § Post-hand capture path step 2 used to order a retry for every
 * `ok:false`. Step 1 only auto-stamps on a DONE outcome, so "record is not DONE" also covers the
 * hand that ran and refused — and for that class the same file says the opposite twice (§ Per-task
 * steps step b and "Hand CONFIG_ERROR → critical exception"). The retry order was the most emphatic
 * and the closest to the decision point, so it won: three dispatches of a hand that should have gone
 * straight to critical exception. The § Escalation ladder had to answer the same question from its
 * own side — its trigger is `on provider/transient Task failure`, and it never said whether a
 * never-DONE capture record is inside it.
 *
 * The unconditional order is pinned as ABSENT from the step's own line, not merely contradicted
 * further down: an adversarial mutation restoring it while keeping the branches intact reproduces
 * the exact defect — two opposite rules in force, the retry one closest to the decision point.
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
 * @returns {string[]} The step-2 block, line by line.
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
 * @returns {string[]} The section, line by line.
 */
function escalationLadderLines() {
  const start = lines.findIndex((line) => /^### Escalation ladder/.test(line));
  assert.notEqual(start, -1, "SKILL.md must keep the § Escalation ladder section.");
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))];
}

/**
 * Group a block into bullets: each `- ` line joined with the continuation lines under it. Matching
 * on the joined bullet instead of the physical line keeps an innocent markdown reflow from
 * reddening a rule that did not change.
 * @param {string[]} blockLines
 * @returns {string[]} One string per bullet.
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

/** The read-backs that mean the hand never delivered by its own verdict. */
const REFUSAL_VERDICTS = ["BLOCKED", "NEEDS_CONTEXT", "CONFIG_ERROR"];

/** Bullets that speak for the whole refusal class. */
const refusalBullets = stepTwoBullets.filter((bullet) =>
  REFUSAL_VERDICTS.every((verdict) => bullet.includes(verdict)),
);

test("#ac-1.1 — capture step 2 splits `ok:false` into causes instead of one retry order", () => {
  assert.ok(
    stepTwoBullets.length >= 2,
    "step 2 must present the causes as distinct branches — a single paragraph is what let the " +
      "retry order swallow the refusal class (#558).",
  );
  assert.match(
    stepTwo,
    /transient/i,
    "step 2 must name the transient branch — the cause that legitimately retries.",
  );
  assert.match(
    stepTwo,
    /refus|deliver/i,
    "step 2 must name the other causes: the hand that ran without delivering.",
  );
});

test("#ac-1.1 — step 2's own line carries no unconditional retry order", () => {
  assert.doesNotMatch(
    stepTwoHeader,
    /(?:re-?dispatch|retry)[^.]{0,40}\bhand\b|treat as hand failure/i,
    "the retry order may live ONLY on the transient branch. An unconditional order on the step's " +
      "own line is the #558 defect and the added branches do not neutralise it — that line is the " +
      "most emphatic text at the decision point, so it wins the reading.",
  );
  assert.doesNotMatch(
    stepTwoHeader,
    /\balways\b/i,
    "the step's line must not make a blanket claim about what `ok:false` means — the causes have " +
      "opposite outlets and one of them (`DONE_WITH_CONCERNS`) is not a failure at all.",
  );
});

test("#ac-1.1 — every bullet naming the refusal class routes to CRITICAL EXCEPTION, no retry", () => {
  assert.ok(
    refusalBullets.length >= 1,
    "step 2 must carry a branch naming all three non-delivering read-backs " +
      `(${REFUSAL_VERDICTS.join(", ")}) — the class that must never be re-dispatched.`,
  );

  for (const bullet of refusalBullets) {
    assert.match(
      bullet,
      /CRITICAL EXCEPTION/,
      "a bullet that speaks for the refusal class must state its outlet; 'do not retry' alone " +
        "leaves the orchestrator with no next move.",
    );
    assert.match(
      bullet,
      /\b(?:no retry|not\b[^.]{0,40}\bre-?dispatch|never\b[^.]{0,40}\bre-?dispatch|do not retry)/i,
      "the refusal class must have the re-dispatch forbidden in words — naming the outlet without " +
        "denying the retry leaves both rules in force, which is the #558 defect.",
    );
  }
});

test("#ac-1.1 — the refusal branch agrees with the two rules that already govern this class", () => {
  const branch = refusalBullets.find((bullet) => /Per-task steps/.test(bullet));
  assert.ok(
    branch,
    "the refusal branch must point at § Per-task steps step b by SECTION NAME — the contradicting " +
      "rule is there, and line numbers drift (#556).",
  );
  assert.match(
    branch,
    /Hand CONFIG_ERROR/,
    "the refusal branch must point at the § Escalation ladder rule 'Hand CONFIG_ERROR → critical " +
      "exception', the other rule this step used to contradict.",
  );
  assert.doesNotMatch(
    branch,
    /:\d{2,}/,
    "cross-references must be by section name, never by line number (#556).",
  );
});

test("#ac-1.1 — the transient branch keeps the same-agent K=3 budget", () => {
  const branch = stepTwoBullets.find(
    (bullet) => /transient/i.test(bullet) && /K=3/.test(bullet),
  );
  assert.ok(
    branch,
    "step 2 must keep a branch granting the same-agent K=3 to a genuinely transient failure — " +
      "#uj-2 says that hand still gets its 3 attempts.",
  );

  assert.match(
    branch,
    /Escalation ladder/,
    "the transient branch must keep naming § Escalation ladder as the budget's home (#538).",
  );
  assert.match(
    branch,
    /existing/i,
    "the transient branch must keep saying the counter is the role's EXISTING one, not a fresh 3 (#538).",
  );
  assert.ok(
    !REFUSAL_VERDICTS.some((verdict) => branch.includes(verdict)),
    "the transient branch must not claim the refusal verdicts — that merge is the defect.",
  );
});

test("#ac-1.1 — a `DONE_WITH_CONCERNS` record is routed, not left in the gap the split opened", () => {
  const branch = stepTwoBullets.find((bullet) => bullet.includes("DONE_WITH_CONCERNS"));
  assert.ok(
    branch,
    "`DONE_WITH_CONCERNS` also answers `ok:false` (the rail stamps on the exact `DONE`), so step 2 " +
      "must say what happens to it — splitting the old blanket rule in two must not leave a third " +
      "reachable outcome with no rule at all.",
  );

  assert.match(
    branch,
    /\b(?:not|never)\b[^.]{0,40}\bre-?dispatch/i,
    "a hand that delivered with reservations must not be re-dispatched — nothing failed.",
  );
  assert.match(
    branch,
    /Axis 2/,
    "the concern's verdict belongs to § Escalation ladder Axis 2 (confirmed by a compliance " +
      "fail/partial or a red gate), not to this capture step.",
  );
});

test("#ac-1.1 — step 2 says how to tell the causes apart, including the pre-dispatch deny", () => {
  // The tie-break bullet is the one that rules on the ABSENCE of a read-back — the ambiguous case
  // the other bullets do not decide.
  const tieBreak = stepTwoBullets.find(
    (bullet) => /read-?back/i.test(bullet) && /absen(?:ce|t)|no read-?back|without a read-?back/i.test(bullet),
  );
  assert.ok(
    tieBreak,
    "step 2 must say what evidence distinguishes the causes when there is no read-back to read; " +
      "without that tie-break the orchestrator picks a branch by feel.",
  );

  assert.match(
    tieBreak,
    /entry-gate|pre-?dispatch|denied/i,
    "the tie-break must exempt the dispatch the harness itself refused before it ran: it leaves no " +
      "read-back AND no record, so 'no read-back → transient' would send a `CONFIG_ERROR` back to " +
      "the retry branch the bullet above just forbade.",
  );
  assert.match(
    tieBreak,
    /CONFIG_ERROR/,
    "the tie-break must name the verdict that exemption belongs to.",
  );
  assert.match(
    tieBreak,
    /missing or unreadable/,
    "the tie-break must name the distinguishing `mark` reason — 'hand-record missing or unreadable' " +
      "(never ran) vs 'hand-record is not DONE' (ran, did not deliver) — so the split keys on an " +
      "observable, not on the orchestrator's guess.",
  );
  assert.match(
    stepTwo,
    /(?:never infer|record's state alone)/i,
    "step 2 must deny the record's state as the discriminator — the cause decides, and the record " +
      "is non-DONE in every branch.",
  );
});

test("#ac-1.1 — the refusal is read off the Task read-back, not off the record", () => {
  const branch = refusalBullets.find((bullet) => /Per-task steps/.test(bullet));
  assert.match(
    branch,
    /read-?back/i,
    "the refusal branch must name the Task read-back as the source of the verdict.",
  );
  assert.match(
    branch,
    /promote[sd]?\b[^.]{0,60}DONE|never records `?CONFIG_ERROR|record can hide/i,
    "the branch must warn that the record is not a second source: the host writes no " +
      "`CONFIG_ERROR` status and promotes a `BLOCKED` hand to `DONE` when git shows touched paths, " +
      "so a record can hide a refusal (host-hand-capture.mjs: resolveOcHandOutcome).",
  );
});

test("#ac-2.1 — the Escalation ladder declares whether a never-DONE capture record is in its trigger", () => {
  const declaration = ladderBullets.find(
    (bullet) => /capture record/i.test(bullet) && /DONE/.test(bullet),
  );
  assert.ok(
    declaration,
    "§ Escalation ladder must answer, on its own side, whether 'the capture record never reached " +
      "DONE' falls under `on provider/transient Task failure` — leaving it implicit at the point of " +
      "use is the #558 defect.",
  );

  assert.match(declaration, /\binside\b/i, "the declaration must say when the class IS inside the trigger.");
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
  const declaration = ladderBullets.find(
    (bullet) => /capture record/i.test(bullet) && /DONE/.test(bullet),
  );

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
