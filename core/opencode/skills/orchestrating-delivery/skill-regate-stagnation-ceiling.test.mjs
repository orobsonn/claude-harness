/**
 * @description The OC post-sniper adversary loop must have a CEILING on cheap-sniper iteration
 * (#565 / #585): after 2 re-gate→sniper cycles still failing on a HIGH, escalate to the executor
 * one tier up (once) — never loop the sniper forever, never invent a stagnation_key apparatus.
 *
 * After #585 the dual-lane vocabulary (stagnation_key, Axis, family-1) is gone. This file keeps
 * protecting the iteration ceiling and the accepted-risk / CRITICAL EXCEPTION terminals that remain
 * load-bearing for the re-gate rail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const lines = skill.split("\n");

function blockStartingWith(prefix) {
  const start = lines.findIndex((line) => line.trimStart().startsWith(prefix));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(
    (line) => line.length > 0 && (!/^\s/.test(line) || /^\s*(?:\d+\.|[-*])\s/.test(line)),
  );
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

const stopSection = (() => {
  const start = lines.findIndex((line) => line.startsWith("### Adversary re-dispatch stop-rule"));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
})();

const iterationCap = blockStartingWith("- **Re-gate→sniper iteration cap");
const noStepLeft = blockStartingWith("- **When there is no step left to spend**");
const capRule = blockStartingWith("- **CAP = 3 rounds");
const disarmRule = blockStartingWith("- **Accepted risk after the CAP escalation");
const advanceSignal = blockStartingWith("- **Stopping with a blocking finding still open");

test("OC orchestrating-delivery: re-gate→sniper iteration is capped at 2 (#565/#585)", () => {
  assert.ok(
    iterationCap,
    "the stop-rule must carry an explicit Re-gate→sniper iteration cap — without it the cheap " +
      "sniper loops forever on a HIGH.",
  );
  assert.match(
    iterationCap,
    /\b2\b/,
    "the cap must name 2 cycles before the stronger-hand climb.",
  );
  assert.match(
    iterationCap,
    /executor one tier up|executor-low.*executor-medium/i,
    "after the cap the next fix must go to the executor one tier up.",
  );
  assert.match(
    iterationCap,
    /(?:\*\*|__|\*)?\b(?:not|never)\b(?:\*\*|__|\*)?[^.]{0,60}sniper/i,
    "the third sniper pass must be denied explicitly.",
  );
});

test("OC orchestrating-delivery: dual-lane stagnation vocabulary is absent (#585 #ac-1.1)", () => {
  assert.doesNotMatch(
    skill,
    /stagnation_key/,
    "stagnation_key is dual-lane invented vocabulary — must not appear after the format-CC cut.",
  );
  assert.doesNotMatch(
    skill,
    /\bAxis 1\b|\bAxis 2\b/,
    "Axis 1 / Axis 2 naming is dual-lane invented vocabulary.",
  );
  assert.doesNotMatch(
    skill,
    /adversary_loop_count/,
    "adversary_loop_count disambiguation prose is dual-lane invented vocabulary.",
  );
  assert.doesNotMatch(
    skill,
    /family-1/,
    "family-1 vocabulary is dual-lane invented vocabulary.",
  );
});

test("OC orchestrating-delivery: exhausted stronger-hand is terminal, not more sniper (#565)", () => {
  assert.ok(noStepLeft, "must state what happens when no tier step is left.");
  assert.match(
    noStepLeft,
    /CAP = 3|operator|CRITICAL EXCEPTION/i,
    "with no step left the flow escalates to the operator / CRITICAL EXCEPTION.",
  );
  assert.match(
    iterationCap + noStepLeft,
    /at most one stronger-hand attempt/i,
    "the ladder is finite — one stronger attempt per task.",
  );
});

test("OC orchestrating-delivery: CAP=3 still escalates with ≥ medium open (#565)", () => {
  assert.ok(capRule, "the CAP = 3 bullet must survive.");
  assert.match(capRule, /≥ medium|blocking/i, "CAP fires on open ≥ medium findings.");
  assert.match(capRule, /pt-br|operator/i, "CAP escalates to the operator in product language.");
});

test("OC orchestrating-delivery: CRITICAL EXCEPTION / accept terminals stamp correctly (#565)", () => {
  assert.match(
    stopSection,
    /stamps nothing|Leave `regate_pending` unmatched/i,
    "a CRITICAL EXCEPTION terminal must authorize no regate-passed.",
  );
  assert.ok(disarmRule, "accepted-risk disarm must survive.");
  assert.match(
    stopSection,
    /`action: regate-passed`/,
    "accept clears the rail only via the mechanical stamp.",
  );
});

test("OC orchestrating-delivery: open-blocking signal reaches shipper brief (#565)", () => {
  assert.ok(advanceSignal, "stopping with a blocking finding open must be documented.");
  assert.match(advanceSignal, /`shipper` brief/, "signal must reach the shipper brief.");
  assert.match(
    advanceSignal,
    /SIGNAL, not the accept|not the accept/i,
    "headless signal is not an accept.",
  );
});

test("OC orchestrating-delivery: step h carries protected round/tier state forward (#565)", () => {
  const stepH = lines.find((line) => line.startsWith("| h | Record |"));
  assert.ok(stepH, "the Per-task steps table must keep step h (Record) as a single row.");
  assert.match(
    stepH,
    /read-modify-write|read the file off disk first/i,
    "step h itself must say the rewrite is read-modify-write.",
  );
  assert.match(
    stepH,
    /round counter|tier-step|SPENT/i,
    "step h must name the protected block's contents (round counter / tier-step SPENT).",
  );
  assert.doesNotMatch(
    stepH,
    /stagnation_key/,
    "step h must not carry the deleted stagnation_key apparatus.",
  );
});

test("OC orchestrating-delivery: CC-form isGrave + light paths present (#585)", () => {
  assert.match(stopSection, /isGrave/, "isGrave predicate must be present.");
  assert.match(
    stopSection,
    /RED pre-fix|red→green/i,
    "red→green light path must be present.",
  );
  assert.match(
    stopSection,
    /spot-check|virgin adversary spot/i,
    "virgin adversary spot-check must be present.",
  );
});
