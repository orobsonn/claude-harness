/**
 * @description The OC post-sniper adversary loop must document both exits it lacked (#544): a
 * stronger hand before the cheap sniper is looped to death, and a mechanical way to clear an
 * orphan `regate_pending` once the operator accepts the residual risk.
 *
 * After #585 the stronger-hand rule is the CC-form "Re-gate→sniper iteration cap" (2 cycles →
 * executor one tier up, once). Axis vocabulary is gone; the contract is not.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const skill = readFileSync(join(here, "SKILL.md"), "utf8");
const markerAuthority = readFileSync(
  join(here, "..", "..", "plugin", "marker-authority.ts"),
  "utf8",
);

/** The runtime's privileged `mark` actions, read from the source of truth rather than restated. */
function runtimeMarkActions() {
  const block = markerAuthority.match(/ACTIONS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, "marker-authority.ts must keep its privileged ACTIONS set greppable.");
  return new Set([...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]));
}

const lines = skill.split("\n");

function blockStartingWith(prefix) {
  const start = lines.findIndex((line) => line.trimStart().startsWith(prefix));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.length > 0 && !/^\s/.test(line));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join("\n");
}

const strongerHandRule = blockStartingWith("- **Re-gate→sniper iteration cap");
const noStepLeftRule = blockStartingWith("- **When there is no step left to spend**");
const whichFailureRule = blockStartingWith("- **Which failure this bullet governs");
const disarmRule = blockStartingWith("- **Accepted risk after the CAP escalation");
const stepG = lines.find((line) => line.startsWith("| g | Fix |"));

test("OC orchestrating-delivery: the post-sniper loop escalates to a stronger hand (#544 #ac-1.1)", () => {
  assert.ok(
    strongerHandRule,
    "the stop-rule section must carry the stronger-hand escalation as its own bullet.",
  );
  assert.match(
    strongerHandRule,
    /executor-low.*executor-medium.*executor-high/,
    "the rule must name the tier step it spends.",
  );
  assert.match(
    strongerHandRule,
    /(?:\*\*|__|\*)?\b(?:not|never)\b(?:\*\*|__|\*)?[^.]{0,60}sniper/i,
    "the rule must explicitly deny the third sniper pass.",
  );
  assert.match(
    strongerHandRule,
    /one tier|once per task|never chained/i,
    "the rule must bind the step as one tier up, once — not an unbounded climb.",
  );
});

test("OC orchestrating-delivery: the escalated executor may not delete the frozen test (#544)", () => {
  assert.match(
    strongerHandRule,
    /locked_tests[\s\S]{0,120}(?:inside|within)[\s\S]{0,20}`scope_paths`/i,
    "the brief must carve the frozen `locked_tests` out even when they live INSIDE `scope_paths`.",
  );
  assert.match(
    strongerHandRule,
    /untouched|unrecoverable/i,
    "the carve-out must state the consequence (untouched / unrecoverable).",
  );
});

test("OC orchestrating-delivery: the tier-step flag is persisted, not remembered (#544)", () => {
  assert.match(
    strongerHandRule,
    /shared_context\.md/,
    "the 'tier step spent' flag must live on disk.",
  );
  assert.match(
    strongerHandRule + (noStepLeftRule || ""),
    /compaction|SPENT/i,
    "the rule must say the flag survives compaction / is SPENT on disk.",
  );
});

test("OC orchestrating-delivery: a red gate stays the tier-step terminal, not this loop's (#544)", () => {
  assert.ok(
    whichFailureRule,
    "the rule must say which failure it governs.",
  );
  assert.match(
    whichFailureRule,
    /CRITICAL EXCEPTION/,
    "the red-gate branch must route to CRITICAL EXCEPTION.",
  );
  assert.match(
    whichFailureRule,
    /GREEN|green/,
    "the branch this rule owns must be named (adversary HIGH with gates green).",
  );
});

test("OC orchestrating-delivery: the escalation fires on a NEW finding too (#544 #ac-1.1)", () => {
  assert.match(
    strongerHandRule,
    /same defect or a brand-new one|whether the same defect/i,
    "the trigger must cover a new finding created by the previous fix.",
  );
});

test("OC orchestrating-delivery: the stronger-hand escape terminates (#544 #ac-1.1)", () => {
  assert.ok(
    noStepLeftRule,
    "the rule must state what happens when no tier step is left.",
  );
  assert.match(
    noStepLeftRule,
    /executor-high|already spent/,
    "the exhausted case must name how it is recognised.",
  );
  assert.match(
    noStepLeftRule,
    /CAP = 3|operator/,
    "with no step left the flow must fall back to CAP=3 operator escalation.",
  );
  assert.match(
    strongerHandRule + noStepLeftRule,
    /at most one stronger-hand attempt/i,
    "the ladder must be stated as finite — one stronger attempt per task.",
  );
});

test("OC orchestrating-delivery: accepted risk has a mechanical disarm (#544 #ac-1.2)", () => {
  assert.ok(
    disarmRule,
    "the stop-rule section must document how an orphan `regate_pending` is cleared after CAP.",
  );
  assert.match(disarmRule, /native `mark`/, "the disarm must name the native `mark` tool.");
  assert.match(
    disarmRule,
    /`action: regate-passed`/,
    "the disarm must name the marker action it stamps.",
  );
  assert.match(
    disarmRule,
    /`task_id`[\s\S]{0,40}`sha`/,
    "the disarm must name the arguments the marker requires.",
  );
  assert.ok(
    disarmRule.indexOf("findings.md") < disarmRule.indexOf("`action: regate-passed`") ||
      disarmRule.indexOf("buffers") < disarmRule.indexOf("`action: regate-passed`"),
    "the record step must come BEFORE the stamp step.",
  );
  assert.match(disarmRule, /shipper/, "the record must be carried into the `shipper` brief.");
  assert.match(
    disarmRule,
    /(?:\*\*|__|\*)?\b(?:never|not|no)\b[^.]{0,80}(?:hand-edit|edit)[^.]{0,40}gate-state|gate-state\.json[^.]{0,80}(?:never|not)/i,
    "the disarm must forbid hand-editing gate-state.json.",
  );
});

test("OC orchestrating-delivery: the disarm names only actions the runtime accepts (#544 #ac-1.2)", () => {
  const actions = runtimeMarkActions();
  const named = [...disarmRule.matchAll(/`action:\s*([a-z0-9_-]+)`/gi)].map((match) => match[1]);
  assert.notEqual(named.length, 0, "the disarm must name at least one `mark` action.");
  for (const action of named) {
    assert.ok(
      actions.has(action),
      `the disarm names \`action: ${action}\`, which marker-authority.ts does not accept.`,
    );
  }
});

test("OC orchestrating-delivery: step g points at the exits, and lists the fidelity one (#544)", () => {
  assert.ok(stepG, "the Per-task steps table must keep step g (Fix) as a single row.");
  assert.match(stepG, /delivery-blocking/, "step g must state unmatched regate_pending blocks delivery.");
  assert.doesNotMatch(
    stepG,
    /exactly two documented exits/,
    "the exits must not be enumerated as closed.",
  );
  assert.match(
    stepG,
    /Test-author fidelity escalation/,
    "step g must name the fidelity-escalation exit.",
  );
  assert.match(
    stepG,
    /`sniper-medium`[\s\S]{0,120}DONE|ANY `sniper-medium`/,
    "step g must warn the host arms the rail on any sniper-medium/high DONE.",
  );
  assert.match(
    stepG,
    /Adversary re-dispatch stop-rule/,
    "step g must point at the section holding the exits.",
  );
  assert.match(
    stepG,
    /executor one tier up/,
    "step g must say the fixer stops being the sniper after two cycles.",
  );
});
