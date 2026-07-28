/**
 * @description The OC post-sniper adversary loop must state ONE stop criterion (#545): the rule
 * that decides "I may advance" and the rule that decides "I may stamp `regate-passed`" are the
 * same predicate, and the word `blocking` it hangs on is defined in the document.
 *
 * Why this exists: the stop-rule said advance when the round returns only findings of severity
 * `≤ low`, while step g stamped `regate-passed` only on "zero blocking findings" — and `blocking`
 * was never defined. A round 2 returning a single `low` satisfied one and (read literally) not the
 * other, so the run advanced carrying an unmatched `regate_pending` and only discovered it at
 * `git push`, hours later, with no trace of which task or finding armed it.
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
const onStopRule = blockStartingWith("- On stop with");
const advanceSignalRule = blockStartingWith("- **Stopping with a blocking finding still open");
const stepG = lines.find((line) => line.startsWith("| g | Fix |"));

test("OC orchestrating-delivery: `blocking` is defined, not assumed (#545 #ac-1.2)", () => {
  assert.ok(
    predicateRule,
    "the stop-rule section must define its own predicate — step g hangs its `regate-passed` stamp " +
      "on the word `blocking`, which appeared nowhere else in the document.",
  );
  assert.match(
    predicateRule,
    /`blocking`\s*=\s*severity\s*≥\s*medium/,
    "the definition must name the threshold (`blocking` = severity ≥ medium) — 'blocking findings' " +
      "with no severity attached is the ambiguity this issue closes.",
  );
  assert.match(
    predicateRule,
    /≤ low/,
    "the definition must tie the threshold back to the loop's own '≤ low' wording, or the reader " +
      "still faces two phrasings and has to guess they agree.",
  );
  assert.match(
    predicateRule,
    /`low`[^.]{0,80}never blocks|A `low` never blocks/,
    "the residual case must be settled explicitly: a surviving `low` neither keeps the loop open " +
      "nor withholds the stamp.",
  );
});

test("OC orchestrating-delivery: one criterion, stated as one (#545 #ac-1.1)", () => {
  assert.match(
    predicateRule,
    /(?:one criterion|same mechanism)[\s\S]{0,120}(?:twice|two sides)/i,
    "the definition must declare the two phrasings ONE criterion — restating the threshold without " +
      "saying the two rules are the same mechanism leaves the divergence readable.",
  );
  assert.match(
    predicateRule,
    /step g/i,
    "the stop-rule side must point at step g by name (#ac-1.1 requires an explicit mutual reference).",
  );
  assert.ok(stopRule, "the Stop bullet must survive as its own bullet.");
  assert.match(
    stopRule,
    /clean/i,
    "the Stop bullet must resolve through the shared predicate ('clean'), not restate a second, " +
      "independently-worded threshold.",
  );
});

test("OC orchestrating-delivery: step g points back at the shared predicate (#545 #ac-1.1)", () => {
  assert.ok(stepG, "the Per-task steps table must keep step g (Fix) as a single row.");
  assert.match(
    stepG,
    /zero blocking findings/,
    "step g must keep the condition it stamps on.",
  );
  assert.match(
    stepG,
    /severity ≥ medium/,
    "step g must carry the definition of `blocking` inline — a reader who lands on the table and " +
      "never scrolls up is exactly the one who mis-stamps.",
  );
  assert.match(
    stepG,
    /Adversary re-dispatch stop-rule/,
    "step g must reference the section holding the predicate (mutual reference, #ac-1.1).",
  );
  assert.match(
    stepG,
    /same mechanism|not two thresholds/i,
    "step g must say the stamp and the loop's stop are the same decision, not two independent gates.",
  );
});

test("OC orchestrating-delivery: a stagnation stop authorizes no stamp (#545 #ac-1.1)", () => {
  assert.ok(onStopRule, "the 'On stop' bullet must survive.");
  assert.match(
    onStopRule,
    /clean stop/i,
    "the advance rule must distinguish the clean stop (which clears the rail) from the stagnation " +
      "stop (which does not) — collapsing them is how a blocking finding gets stamped away.",
  );
  assert.match(
    onStopRule + stepG,
    /stagnation[\s\S]{0,120}(?:not clean|no stamp|authorizes no stamp)/i,
    "the stagnation branch must be denied the stamp explicitly on at least one of the two sides.",
  );
  assert.match(
    onStopRule,
    /no blocking finding open/i,
    "the solo advance ('do not wait for the operator') must be scoped to a stop with nothing " +
      "blocking open — unscoped, it contradicts the CAP=3 bullet's 'never advance silently with a " +
      "≥ medium open' and the orchestrator gets two opposite orders for one state.",
  );
});

test("OC orchestrating-delivery: advancing with the rail armed signals at that moment (#545 #ac-1.3)", () => {
  assert.ok(
    advanceSignalRule,
    "the section must state what happens when the loop stops with a blocking finding still open — " +
      "silence there is the whole defect: the run discovers it only at `git push`.",
  );
  assert.match(
    advanceSignalRule,
    /git push|bash-decide/,
    "the rule must name the late failure it prevents (the push-time denial), or the instruction " +
      "reads as optional bookkeeping.",
  );
  assert.match(
    advanceSignalRule,
    /shared_context\.md[\s\S]{0,80}findings\.md/,
    "the signal must be written to both run buffers via bash — a signal that lives only in context " +
      "dies on compaction, exactly on the long runs where it matters.",
  );
  assert.match(
    advanceSignalRule,
    /`task_id`/,
    "the record must name WHICH task's rail is armed — 'something is pending' with no `task_id` is " +
      "the same undiagnosable block the issue reports.",
  );
  assert.match(
    advanceSignalRule,
    /CAP = 3/,
    "the immediate escalation must reuse the existing CAP=3 channel rather than invent a second " +
      "one — its accept branch is what the documented disarm requires as precondition.",
  );
  assert.match(
    advanceSignalRule,
    /HEADLESS/,
    "the headless branch must be covered: with no operator, the signal is the open PR risk item.",
  );
  assert.match(
    advanceSignalRule,
    /entry-decide/,
    "the late failure must be attributed to the right rail — `bash-decide` denies the delivery " +
      "commands, `entry-decide` Gate 3 denies the `shipper` dispatch; a reader grepping the wrong " +
      "module discounts the whole rule.",
  );
});

test("OC orchestrating-delivery: the early escalation never outranks the stronger hand (#545 #ac-1.3)", () => {
  // Stagnation fires from round 2, which is exactly the state #544's climb rule owns: two
  // sniper-answered rounds with a HIGH still open. Escalating there hands the operator an
  // engineering decision the ladder had not finished — the invariant #544 wrote ("accept never
  // replaces the stronger-hand attempt").
  assert.match(
    advanceSignalRule,
    /tier step[\s\S]{0,120}(?:not yet spent|unspent)|Precedence/i,
    "the bullet must state its precedence against the Axis-2 stronger-hand rule — without it, one " +
      "state (stagnation with a HIGH open at round 2) carries two opposite orders.",
  );
  assert.match(
    advanceSignalRule,
    /executor one tier up|stronger hand/i,
    "the precedence must name the move that wins (climb to the executor one tier up), not merely " +
      "defer to another section.",
  );
  assert.match(
    advanceSignalRule,
    /shared_context\.md/,
    "the tier-step flag must be read off disk, like the round counter — memory does not survive " +
      "compaction.",
  );
});

test("OC orchestrating-delivery: the signal survives the harvest (#545 #ac-1.3)", () => {
  // `findings.md` and `shared_context.md` are deleted by the harvester in Phase 5, before the ship,
  // and the ledger is budget-capped. Recording only there is recording nowhere.
  assert.match(
    advanceSignalRule,
    /`shipper` brief/,
    "the record must be carried into the `shipper` brief / PR body — the two run buffers die at " +
      "harvest, so a buffer-only signal leaves no trace of the risk that was taken.",
  );
  assert.match(
    advanceSignalRule,
    /harvester|budget-capped/,
    "the rule must say WHY a third destination is required, or it is the first line dropped.",
  );
});

test("OC orchestrating-delivery: a headless record is a signal, not an accept (#545 #ac-1.3)", () => {
  // The disarm below treats the headless PR risk item as "the decision of record". If the signal
  // this bullet mandates were that same record, the orchestrator could stamp `regate-passed` over
  // an open medium in the same turn it emitted the signal — green by vacuity, worse than the bug.
  assert.match(
    advanceSignalRule,
    /SIGNAL, not the accept|not the accept/i,
    "the headless branch must deny the record any accept value — otherwise the mandated signal " +
      "self-authorizes the disarm and stamps `regate-passed` over a blocking finding.",
  );
  assert.match(
    advanceSignalRule,
    /rail stays armed|authorizes no/i,
    "the consequence must be stated: the rail stays armed after the headless signal.",
  );
});
