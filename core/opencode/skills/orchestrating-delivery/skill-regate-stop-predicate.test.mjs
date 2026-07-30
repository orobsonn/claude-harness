/**
 * @description The OC post-sniper adversary loop must state ONE stop criterion (#545): the rule
 * that decides "I may advance" and the rule that decides "I may stamp `regate-passed`" are the
 * same predicate, and the word `blocking` it hangs on is defined in the document.
 *
 * After #585 the stop-rule is the CC-form (isGrave + red→green + spot-check + iteration cap). The
 * shared `blocking` predicate and the mutual step-g reference remain the load-bearing contract.
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
 * A rule plus its continuation: from the anchored bullet up to the next line that starts a new
 * top-level block. Reflowing a bullet across several lines must not redden CI.
 */
function blockStartingWith(prefix) {
  const start = lines.findIndex((line) => line.trimStart().startsWith(prefix));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.length > 0 && !/^\s/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

const predicateRule = blockStartingWith("- **One predicate");
const stopRule = blockStartingWith("- **Stop** when");
const onStopRule = blockStartingWith("- **On stop with no blocking finding open");
const advanceSignalRule = blockStartingWith("- **Stopping with a blocking finding still open");
const stepG = lines.find((line) => line.startsWith("| g | Fix |"));
const stopSection = (() => {
  const start = lines.findIndex((line) => line.startsWith("### Adversary re-dispatch stop-rule"));
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,3} /.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
})();

test("OC orchestrating-delivery: `blocking` is defined, not assumed (#545 #ac-1.2)", () => {
  assert.ok(
    predicateRule,
    "the stop-rule section must define its own predicate — step g hangs its `regate-passed` stamp " +
      "on the word `blocking`, which appeared nowhere else in the document.",
  );
  assert.match(
    predicateRule,
    /`blocking`\s*=\s*severity\s*≥\s*medium/,
    "the definition must name the threshold (`blocking` = severity ≥ medium).",
  );
  assert.match(
    predicateRule,
    /≤ low/,
    "the definition must tie the threshold back to the loop's own '≤ low' wording.",
  );
  assert.match(
    predicateRule,
    /`low`[^.]{0,80}never blocks|A `low` never blocks/,
    "a surviving `low` neither keeps the loop open nor withholds the stamp.",
  );
});

test("OC orchestrating-delivery: one criterion, stated as one (#545 #ac-1.1)", () => {
  assert.match(
    predicateRule,
    /(?:one criterion|same mechanism)[\s\S]{0,120}(?:twice|two sides)/i,
    "the definition must declare the two phrasings ONE criterion.",
  );
  assert.match(
    predicateRule,
    /step g/i,
    "the stop-rule side must point at step g by name.",
  );
  assert.ok(stopRule, "the Stop bullet must survive as its own bullet.");
  assert.match(
    stopRule,
    /clean/i,
    "the Stop bullet must resolve through the shared predicate ('clean').",
  );
});

test("OC orchestrating-delivery: step g points back at the shared predicate (#545 #ac-1.1)", () => {
  assert.ok(stepG, "the Per-task steps table must keep step g (Fix) as a single row.");
  assert.match(stepG, /zero blocking findings/, "step g must keep the condition it stamps on.");
  assert.match(
    stepG,
    /severity ≥ medium/,
    "step g must carry the definition of `blocking` inline.",
  );
  assert.match(
    stepG,
    /Adversary re-dispatch stop-rule/,
    "step g must reference the section holding the predicate.",
  );
  assert.match(
    stepG,
    /same mechanism|not two thresholds/i,
    "step g must say the stamp and the loop's stop are the same decision.",
  );
});

test("OC orchestrating-delivery: only a clean stop clears the rail (#545 #ac-1.1)", () => {
  assert.ok(onStopRule, "the 'On stop with no blocking finding open' bullet must survive.");
  assert.match(
    onStopRule,
    /clean stop/i,
    "the advance rule must name the clean stop as what clears the rail.",
  );
  assert.match(
    onStopRule + stepG,
    /regate-passed/,
    "the clean stop must be tied to the `regate-passed` stamp.",
  );
});

test("OC orchestrating-delivery: advancing with the rail armed signals at that moment (#545 #ac-1.3)", () => {
  assert.ok(
    advanceSignalRule,
    "the section must state what happens when the loop stops with a blocking finding still open.",
  );
  assert.match(
    advanceSignalRule,
    /git push|bash-decide/,
    "the rule must name the late failure it prevents (the push-time denial).",
  );
  assert.match(
    advanceSignalRule,
    /shared_context\.md[\s\S]{0,80}findings\.md/,
    "the signal must be written to both run buffers via bash.",
  );
  assert.match(advanceSignalRule, /`task_id`/, "the record must name WHICH task's rail is armed.");
  assert.match(
    advanceSignalRule,
    /CAP = 3/,
    "the immediate escalation must reuse the existing CAP=3 channel.",
  );
  assert.match(advanceSignalRule, /HEADLESS/, "the headless branch must be covered.");
  assert.match(
    advanceSignalRule,
    /entry-decide/,
    "the late failure must name entry-decide Gate 3 as well as bash-decide.",
  );
});

test("OC orchestrating-delivery: the stronger hand wins before operator escalation (#545 #ac-1.3)", () => {
  assert.match(
    stopSection,
    /Re-gate→sniper iteration cap|executor one tier up/i,
    "the stop-rule must escalate to the executor one tier up before looping the sniper forever.",
  );
  assert.match(
    stopSection,
    /shared_context\.md/,
    "the tier-step flag must live on disk.",
  );
});

test("OC orchestrating-delivery: the signal survives the harvest (#545 #ac-1.3)", () => {
  assert.match(
    advanceSignalRule,
    /`shipper` brief/,
    "the record must be carried into the `shipper` brief / PR body.",
  );
  assert.match(
    advanceSignalRule,
    /harvester|budget-capped/,
    "the rule must say WHY a third destination is required.",
  );
});

test("OC orchestrating-delivery: a headless record is a signal, not an accept (#545 #ac-1.3)", () => {
  assert.match(
    advanceSignalRule,
    /SIGNAL, not the accept|not the accept/i,
    "the headless branch must deny the record any accept value.",
  );
  assert.match(
    advanceSignalRule,
    /rail stays armed|authorizes no/i,
    "the consequence must be stated: the rail stays armed after the headless signal.",
  );
});

test("OC orchestrating-delivery: CC-form grave / light path is present (#585)", () => {
  assert.match(stopSection, /isGrave/, "stop-rule must carry the isGrave predicate.");
  assert.match(
    stopSection,
    /RED pre-fix|red→green|red->green/i,
    "stop-rule must carry the red→green light path.",
  );
  assert.match(
    stopSection,
    /spot-check|virgin adversary spot/i,
    "stop-rule must carry the virgin adversary spot-check light path.",
  );
});
