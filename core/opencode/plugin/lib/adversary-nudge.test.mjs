/** @description Probes for the spec-adversary acceptance instruction (accept / revise / budget). */
import test from "node:test";
import assert from "node:assert/strict";
import { decideAdversaryNudge } from "./adversary-nudge.mjs";
import { LOOP_THRESHOLDS } from "./loop-decide.mjs";

const PRIMARY = "adversary-family-1";
const SECONDARY = "adversary-family-2";
const DENY = LOOP_THRESHOLDS.adversary.deny;

function state(overrides = {}) {
  return {
    adversary_loop_count: 1,
    primary_review_last_material_unresolved: true,
    primary_review_last_report_hash: "a".repeat(64),
    ...overrides,
  };
}

test("a clean pass is ACCEPTED: stamp the marker and go to the planner, never re-attack", () => {
  const res = decideAdversaryNudge({
    subagentType: PRIMARY,
    state: state({ primary_review_last_material_unresolved: false }),
  });
  assert.equal(res.action, "inject");
  assert.equal(res.kind, "accept");
  assert.match(res.context, /mark\(\{ action: "adversary_fired" \}\)/);
  assert.match(res.context, /Do NOT re-attack/);
});

test("a material finding with rounds left says revise the spec FIRST, then re-attack", () => {
  const res = decideAdversaryNudge({ subagentType: PRIMARY, state: state() });
  assert.equal(res.kind, "revise");
  assert.match(res.context, /revise spec\.md/);
  // The incident's treadmill: re-attacking an unchanged spec yields the same class of finding.
  assert.match(res.context, /WITHOUT changing spec\.md wastes the round/);
  // And 'clean' must not read as the only exit, or the loop runs to the cap again.
  assert.match(res.context, /empty issues array is not a realistic bar/);
});

test("a loop that is not converging STOPS and escalates to the human — nothing refuses it, so the instruction must", () => {
  // There is no deterministic cap on the adversary loop any more (a hard refusal froze two real
  // runs). The escalation instruction is the whole stop mechanism, including past the threshold.
  for (const s of [
    state({ adversary_loop_count: DENY }),
    state({ adversary_loop_count: DENY + 3 }),
    state({ adversary_loop_count: 2, review_status: "review_cap_reached" }),
  ]) {
    const res = decideAdversaryNudge({ subagentType: PRIMARY, state: s });
    assert.equal(res.kind, "escalate");
    assert.match(res.context, /STOP re-attacking/);
    assert.match(res.context, /stopping is YOUR call/);
    // Interactive: stop and wait for the operator; never self-approve the ceremony marker.
    assert.match(res.context, /escalate to the operator/);
    assert.match(res.context, /WAIT for the answer/);
    assert.match(res.context, /Do not stamp the marker on your own judgement/);
    // Headless has no human in the turn: record the risks, proceed, let the PR gate see them.
    assert.match(res.context, /Open risks/);
    assert.match(res.context, /mark\(\{ action: "adversary_fired" \}\)/);
    assert.match(res.context, /dispatch `planner`/);
  }
});

test("the loop is the SPEC pass only — a per-task adversary is the implementation loop", () => {
  const res = decideAdversaryNudge({ subagentType: PRIMARY, state: state(), taskId: "task-3" });
  assert.equal(res.action, "skip");
  assert.match(res.reason, /per-task/);
});

test("only the primary family drives the loop, and only before acceptance", () => {
  assert.equal(decideAdversaryNudge({ subagentType: SECONDARY, state: state() }).action, "skip");
  assert.equal(decideAdversaryNudge({ subagentType: PRIMARY, state: state({ adversary_fired: true }) }).action, "skip");
  assert.equal(decideAdversaryNudge({ subagentType: "plan-reviewer-family-1", state: state() }).action, "skip");
  assert.equal(decideAdversaryNudge({ subagentType: "executor-high", state: state() }).action, "skip");
});

test("a corrupt counter or non-object state never throws", () => {
  assert.equal(decideAdversaryNudge({ subagentType: PRIMARY, state: state({ adversary_loop_count: "many" }) }).kind, "revise");
  assert.equal(decideAdversaryNudge({ subagentType: PRIMARY, state: null }).action, "skip");
  assert.equal(decideAdversaryNudge().action, "skip");
});

test("no recorded primary report means no nudge: never tell the orchestrator to stamp on absent evidence", () => {
  // The marker carries the proof that a spec-adversary pass happened. An empty state must not
  // produce an 'accept' instruction — that would forge exactly that proof. Also the shape of this
  // incident's round 1, where the primary came back malformed and nothing useful had landed yet.
  for (const bad of [{}, { adversary_loop_count: 2 }, { primary_review_last_report_hash: "" }]) {
    const res = decideAdversaryNudge({ subagentType: PRIMARY, state: bad });
    assert.equal(res.action, "skip", JSON.stringify(bad));
    assert.match(res.reason, /no recorded primary/);
  }
});
