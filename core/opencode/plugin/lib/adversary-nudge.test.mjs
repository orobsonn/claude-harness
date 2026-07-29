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
    review_outcomes: [{ logical_role: "adversary", family: 1, task_id: "", outcome: "useful" }],
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

test("run-wide adversary outcomes from earlier phases do not spend a fresh spec loop", () => {
  const res = decideAdversaryNudge({
    subagentType: PRIMARY,
    state: state({
      adversary_loop_count: DENY + 3,
      review_outcomes: [
        { logical_role: "adversary", family: 1, task_id: "task-1", outcome: "useful" },
        { logical_role: "adversary", family: 1, task_id: "task-2", outcome: "useful" },
        { logical_role: "adversary", family: 1, task_id: "", outcome: "useful" },
      ],
    }),
  });

  assert.equal(res.kind, "revise");
  assert.match(res.context, /round 1\/4/);
});

test("the nudge reflects useful rounds from the current spec loop, not the run total", () => {
  const reviewOutcomes = Array.from({ length: DENY }, (_, index) => ({
    logical_role: "adversary",
    family: 1,
    task_id: "",
    outcome: "useful",
    call_id: `spec-${index + 1}`,
  }));
  const res = decideAdversaryNudge({
    subagentType: PRIMARY,
    state: state({ adversary_loop_count: DENY + 8, review_outcomes: reviewOutcomes }),
  });

  assert.equal(res.kind, "escalate");
  assert.match(res.context, new RegExp(`\\b${DENY} spec-adversary rounds\\b`));
});

test("a spec change after escalation opens a new taskless loop at round one", () => {
  const previousLoop = Array.from({ length: DENY }, (_, index) => ({
    logical_role: "adversary",
    family: 1,
    task_id: "",
    outcome: "useful",
    report_hash: "same-report",
    identity_hash: `previous-${index + 1}`,
  }));
  const res = decideAdversaryNudge({
    subagentType: PRIMARY,
    surfaceHash: "changed-spec",
    state: state({
      adversary_loop_count: DENY + 1,
      review_outcomes: [
        ...previousLoop,
        { logical_role: "adversary", family: 1, task_id: "", outcome: "useful", report_hash: "same-report", identity_hash: "new-loop-1" },
      ],
      spec_adversary_escalation: {
        round: DENY,
        report_hash: previousLoop.at(-1).report_hash,
        identity_hash: previousLoop.at(-1).identity_hash,
        surface_hash: "original-spec",
      },
    }),
  });

  assert.equal(res.kind, "revise");
  assert.equal(res.round, 1);
  assert.match(res.context, /round 1\/4/);
});

test("ignoring an escalation without changing the spec does not reset its loop", () => {
  const reviewOutcomes = Array.from({ length: DENY + 1 }, (_, index) => ({
    logical_role: "adversary",
    family: 1,
    task_id: "",
    outcome: "useful",
    report_hash: "same-report",
    identity_hash: `spec-${index + 1}`,
  }));
  const res = decideAdversaryNudge({
    subagentType: PRIMARY,
    surfaceHash: "unchanged-spec",
    state: state({
      adversary_loop_count: DENY + 1,
      review_outcomes: reviewOutcomes,
      spec_adversary_escalation: {
        round: DENY,
        report_hash: "same-report",
        identity_hash: `spec-${DENY}`,
        surface_hash: "unchanged-spec",
      },
    }),
  });

  assert.equal(res.kind, "escalate");
  assert.equal(res.round, DENY + 1);
});

test("a loop that is not converging STOPS and escalates to the human — nothing refuses it, so the instruction must", () => {
  // There is no deterministic cap on the adversary loop any more (a hard refusal froze two real
  // runs). The escalation instruction is the whole stop mechanism, including past the threshold.
  for (const s of [
    state({
      adversary_loop_count: DENY,
      review_outcomes: Array.from({ length: DENY }, () => ({ logical_role: "adversary", family: 1, task_id: "", outcome: "useful" })),
    }),
    state({
      adversary_loop_count: DENY + 3,
      review_outcomes: Array.from({ length: DENY + 3 }, () => ({ logical_role: "adversary", family: 1, task_id: "", outcome: "useful" })),
    }),
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

test("legacy adversary aliases drive the same loop, and only before acceptance", () => {
  assert.equal(decideAdversaryNudge({ subagentType: SECONDARY, state: state() }).action, "inject");
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
