/**
 * @description The OC post-sniper adversary loop must document both exits it lacked (#544): a
 * stronger hand before the cheap sniper is looped to death, and a mechanical way to clear an
 * orphan `regate_pending` once the operator accepts the residual risk.
 *
 * Why this exists: step g arms sealed `regate_pending` on a HIGH fix and `bash-decide` denies
 * `git push` / `gh pr` until a matching `regate-passed` exists. The only cap on the loop was
 * "CAP = 3 rounds → escalate to the operator", and the operator answering "aceito o risco" cleared
 * nothing — delivery stayed blocked forever, with no stronger hand tried and no documented disarm.
 *
 * The marker the doc names is pinned against the runtime's own privileged action list
 * (`plugin/marker-authority.ts`), so prose can never invent an "accepted-risk" action the native
 * `mark` tool would reject.
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

const strongerHandRule = blockStartingWith("- **After 2 sniper-fixed rounds still leaving a HIGH open");
const noStepLeftRule = blockStartingWith("- **When there is no step left to spend**");
const axisTerminalRule = blockStartingWith("- **Which failure this bullet governs");
const disarmRule = blockStartingWith("- **Accepted risk after the CAP escalation");
const stepG = lines.find((line) => line.startsWith("| g | Fix |"));

test("OC orchestrating-delivery: the post-sniper loop escalates to a stronger hand (#544 #ac-1.1)", () => {
  assert.ok(
    strongerHandRule,
    "the stop-rule section must carry the stronger-hand escalation as its own bullet — without it " +
      "the only documented cap is CAP=3 and the cheap sniper is looped to death.",
  );
  assert.match(
    strongerHandRule,
    /executor-low.*executor-medium.*executor-high/,
    "the rule must name the tier step it spends (`executor-low` → `executor-medium` → " +
      "`executor-high`) — 'a stronger hand' with no named role is not dispatchable.",
  );
  assert.match(
    strongerHandRule,
    /(?:\*\*|__|\*)?\b(?:not|never)\b(?:\*\*|__|\*)?[^.]{0,60}sniper/i,
    "the rule must explicitly deny the third sniper pass — naming the executor without denying " +
      "the sniper leaves both readings open.",
  );
  assert.match(
    strongerHandRule,
    /Axis 2/,
    "the rule must bind the step to the Escalation ladder's Axis 2, whose budget it spends — an " +
      "unbound extra dispatch would silently grant the task a second tier step.",
  );
});

test("OC orchestrating-delivery: the escalated executor may not delete the frozen test (#544)", () => {
  // The brief authorises rewriting the failed attempt inside `scope_paths`. OC has no per-task
  // commit, so a frozen locked_test that happens to live inside `scope_paths` would be deleted
  // irrecoverably — and the gate would then pass by vacuity.
  assert.match(
    strongerHandRule,
    /locked_tests[\s\S]{0,120}(?:inside|within)[\s\S]{0,20}`scope_paths`/i,
    "the brief must carve the frozen `locked_tests` out even when they live INSIDE `scope_paths` — " +
      "Axis 2's own clause only covers what is outside.",
  );
  assert.match(
    strongerHandRule,
    /untouched|unrecoverable/i,
    "the carve-out must state the consequence (untouched / unrecoverable), not just list the path.",
  );
});

test("OC orchestrating-delivery: the tier-step flag is persisted, not remembered (#544)", () => {
  assert.match(
    strongerHandRule,
    /shared_context\.md/,
    "the 'tier step spent' flag is the floor of this escape — it must live on disk beside the round " +
      "counter, or compaction grants the task a second step and reopens the loop.",
  );
  assert.match(
    strongerHandRule + noStepLeftRule,
    /compaction/i,
    "the rule must say why the flag is persisted — an unexplained instruction is the first to be dropped.",
  );
});

test("OC orchestrating-delivery: a red gate stays Axis 2's terminal, not this loop's (#544)", () => {
  assert.ok(
    axisTerminalRule,
    "the rule must say which failure it governs — Axis 2 already declares a red gate on the " +
      "escalated executor terminal, and two instructions for one observable state is a defect.",
  );
  assert.match(
    axisTerminalRule,
    /CRITICAL EXCEPTION/,
    "the red-gate branch must route to Axis 2's CRITICAL EXCEPTION.",
  );
  assert.match(
    axisTerminalRule,
    /GREEN|green/,
    "the branch this rule owns must be named too (an adversary HIGH with the task's gates green).",
  );
});

test("OC orchestrating-delivery: the escalation fires on a NEW finding too (#544 #ac-1.1)", () => {
  // The reported scenario is a fix that grows a *fresh* race each round. Keyed on "the same
  // finding", the rule would never fire in exactly the case that motivated it.
  assert.match(
    strongerHandRule,
    /same defect or a brand-new one|whether it is the same defect/i,
    "the trigger must cover a new finding created by the previous fix, not only a repeat of the " +
      "same defect — the deadlock report is precisely the fresh-finding case.",
  );
});

test("OC orchestrating-delivery: the stronger-hand escape terminates (#544 #ac-1.1)", () => {
  assert.ok(
    noStepLeftRule,
    "the rule must state what happens when no tier step is left — an escape with no floor is a " +
      "new endless loop, not a fix for the old one.",
  );
  assert.match(
    noStepLeftRule,
    /executor-high|already spent/,
    "the exhausted case must name how it is recognised (step already spent, or already at the " +
      "top tier `executor-high`).",
  );
  assert.match(
    noStepLeftRule,
    /CAP = 3|operator/,
    "with no step left the flow must fall back to the existing CAP=3 operator escalation, not to " +
      "more sniper rounds.",
  );
  assert.match(
    strongerHandRule + noStepLeftRule,
    /at most one stronger-hand attempt/i,
    "the ladder must be stated as finite — one stronger attempt per task, then the operator decides.",
  );
});

test("OC orchestrating-delivery: accepted risk has a mechanical disarm (#544 #ac-1.2)", () => {
  assert.ok(
    disarmRule,
    "the stop-rule section must document how an orphan `regate_pending` is cleared after the CAP " +
      "escalation — the operator's accept is a product decision that clears nothing by itself.",
  );
  assert.match(
    disarmRule,
    /native `mark`/,
    "the disarm must name the tool that performs it (the native `mark` tool).",
  );
  assert.match(
    disarmRule,
    /`action: regate-passed`/,
    "the disarm must name the marker action it stamps.",
  );
  assert.match(
    disarmRule,
    /`task_id`[\s\S]{0,40}`sha`/,
    "the disarm must name the arguments the marker requires (`task_id` + `sha`), or the call is " +
      "rejected and the deadlock stands.",
  );
  assert.ok(
    disarmRule.indexOf("findings.md") < disarmRule.indexOf("`action: regate-passed`"),
    "the record step must come BEFORE the stamp step — stamping first and recording later loses " +
      "the risk on any interruption, and the order is the whole control.",
  );
  assert.match(
    disarmRule,
    /shipper/,
    "the record must be carried into the `shipper` brief / PR body: the `harvester` deletes " +
      "`findings.md` and `shared_context.md` in Phase 5, before the ship, so buffer-only recording " +
      "leaves no durable trace of an accepted HIGH.",
  );
  assert.match(
    disarmRule,
    /(?:\*\*|__|\*)?\b(?:never|not|no)\b[^.]{0,80}(?:hand-edit|edit)[^.]{0,40}gate-state|gate-state\.json[^.]{0,80}(?:never|not)/i,
    "the disarm must forbid hand-editing gate-state.json — a non-array `regate_pending` denies " +
      "fail-closed, trading one deadlock for a worse one.",
  );
});

test("OC orchestrating-delivery: the disarm names only actions the runtime accepts (#544 #ac-1.2)", () => {
  const actions = runtimeMarkActions();
  const named = [...disarmRule.matchAll(/`action:\s*([a-z0-9_-]+)`/gi)].map((match) => match[1]);
  assert.notEqual(named.length, 0, "the disarm must name at least one `mark` action.");
  for (const action of named) {
    assert.ok(
      actions.has(action),
      `the disarm names \`action: ${action}\`, which marker-authority.ts does not accept — the ` +
        "native `mark` tool would reject the call and the rail would stay armed.",
    );
  }
});

test("OC orchestrating-delivery: step g points at the exits, and lists the fidelity one (#544)", () => {
  assert.ok(stepG, "the Per-task steps table must keep step g (Fix) as a single row.");
  assert.match(
    stepG,
    /delivery-blocking/,
    "step g must keep stating that an unmatched `regate_pending` blocks delivery.",
  );
  assert.doesNotMatch(
    stepG,
    /exactly two documented exits/,
    "the exits must not be enumerated as closed: the fidelity-escalation rail also arms and " +
      "clears this marker, and a closed list makes an orchestrator refuse a legitimate stamp.",
  );
  assert.match(
    stepG,
    /Test-author fidelity escalation/,
    "step g must name the third exit (the independent `compliance` fidelity PASS re-gate).",
  );
  assert.match(
    stepG,
    /`sniper-medium`[\s\S]{0,120}DONE|ANY `sniper-medium`/,
    "step g must warn that the host arms the rail on any `sniper-medium`/`sniper-high` DONE, " +
      "whatever the severity — otherwise an ordinary medium fix leaves an orphan pending that no " +
      "documented step clears.",
  );
  assert.match(
    stepG,
    /Adversary re-dispatch stop-rule/,
    "the sentence that declares the block must point at the section holding the exits — a reader " +
      "who stops at step g is exactly the one who hits the deadlock.",
  );
  assert.match(
    stepG,
    /executor one tier up/,
    "step g must say the fixer stops being the sniper after the loop's two sniper rounds.",
  );
});
