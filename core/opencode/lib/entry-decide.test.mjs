/** @description Pure decision probes for decideEntryTask / hasFidelityPass (OC entry-gate). */
import test from "node:test";
import assert from "node:assert/strict";
import { decideEntryTask, hasFidelityPass, throwIfDenied } from "./entry-decide.mjs";

function fullCeremony(extra = {}) {
  return {
    feature_id: "feat",
    classified: true,
    mode: "FULL",
    brainstormed: true,
    adversary_fired: true,
    ...extra,
  };
}

test("non-delivery role always allows regardless of gate-state", () => {
  const decision = decideEntryTask({ subagentType: "explore", gateState: {} });
  assert.equal(decision.ok, true);
  assert.equal(decision.decision, "allow");
});

test("delivery role with no classify/triage/mode stamp → ceremony missing deny", () => {
  const decision = decideEntryTask({ subagentType: "executor", gateState: {} });
  assert.equal(decision.ok, false);
  assert.equal(decision.decision, "deny");
  assert.match(decision.reason, /\[entry-gate\]/);
  assert.match(decision.reason, /ceremony missing/);
});

test("#ac-1.1 QUICK/no-ceremony denies EVERY delivery role, executor and sniper included (CC parity — no per-role exemption)", () => {
  for (const role of ["compliance", "security", "harvester", "shipper", "executor", "sniper"]) {
    for (const mode of ["QUICK", "no-ceremony"]) {
      const decision = decideEntryTask({
        subagentType: role,
        gateState: { mode, fidelity_pass: ["feat/t1"] },
        featureId: "feat",
        taskId: "t1",
      });
      assert.equal(decision.ok, false, `${role} under ${mode} should deny`);
      assert.match(decision.reason, /\[entry-gate\]/);
      assert.match(decision.reason, /LIGHT or FULL/);
    }
  }
});

test("executor under LIGHT/FULL with fidelity-pass is allowed", () => {
  for (const mode of ["LIGHT", "FULL"]) {
    const decision = decideEntryTask({
      subagentType: "executor",
      gateState: { mode, fidelity_pass: ["feat/t1"] },
      featureId: "feat",
      taskId: "t1",
    });
    assert.equal(decision.ok, true);
  }
});

test("planner without brainstormed → CEREMONY_PROOF_REQUIRED brainstorming deny", () => {
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: { feature_id: "feat", classified: true, mode: "FULL" },
    dispatchFeatureId: "feat",
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /\[entry-gate\]/);
  const denial = JSON.parse(decision.reason.slice(decision.reason.indexOf("{")));
  assert.equal(denial.code, "CEREMONY_PROOF_REQUIRED");
  assert.equal(denial.missing_proof, "brainstorming_completion_evidence");
  assert.deepEqual(denial.next_transition, { phase: "brainstorming", action: "resume", marker: "brainstormed" });
});

test("planner with brainstormed but not adversary_fired → spec-adversary deny", () => {
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullCeremony({ adversary_fired: false }),
    dispatchFeatureId: "feat",
  });
  assert.equal(decision.ok, false);
  const denial = JSON.parse(decision.reason.slice(decision.reason.indexOf("{")));
  assert.equal(denial.missing_proof, "spec_adversary_completion_evidence");
  assert.deepEqual(denial.next_transition, { phase: "spec-adversary", action: "resume", marker: "adversary_fired" });
});

test("planner with full ceremony for the matching feature → allow", () => {
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullCeremony(),
    dispatchFeatureId: "feat",
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.decision, "allow");
});

test("planner dispatchFeatureId mismatch treats gate-state as ceremony-not-done (mirrors CC entry-gate.mjs featureMismatch)", () => {
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullCeremony({ feature_id: "stale-feature" }),
    dispatchFeatureId: "new-feature",
  });
  assert.equal(decision.ok, false);
  const denial = JSON.parse(decision.reason.slice(decision.reason.indexOf("{")));
  assert.equal(denial.missing_proof, "brainstorming_completion_evidence");
});

test("planner dispatchFeatureId matching gate-state's feature_id is not a mismatch", () => {
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullCeremony({ feature_id: "feat" }),
    dispatchFeatureId: "feat",
  });
  assert.equal(decision.ok, true);
});

test("planner with no declared dispatchFeatureId (dispatch-time) does not false-positive as mismatch", () => {
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullCeremony({ feature_id: "feat" }),
  });
  assert.equal(decision.ok, true);
});

test("planner: stale input.featureId alone (no dispatchFeatureId) never triggers mismatch — only dispatchFeatureId is compared", () => {
  const decision = decideEntryTask({
    subagentType: "planner",
    gateState: fullCeremony({ feature_id: "feat" }),
    featureId: "some-other-collapsed-value",
  });
  assert.equal(decision.ok, true);
});

test("adversary role is allowed after LIGHT/FULL classification before adversary_fired", () => {
  const decision = decideEntryTask({ subagentType: "adversary-family-1", gateState: { mode: "FULL" } });
  assert.equal(decision.ok, true);
  assert.equal(decision.reason, "adversary-allowed");
});

test("test-author is exempt from the fidelity rail", () => {
  const decision = decideEntryTask({
    subagentType: "test-author",
    gateState: { mode: "FULL" },
  });
  assert.equal(decision.ok, true);
});

test("executor blocked until feature-level fidelity-pass; unblocked once present", () => {
  const gateState = { mode: "FULL", feature_id: "feat" };
  const blocked = decideEntryTask({ subagentType: "executor-low", gateState, featureId: "feat", taskId: "t1" });
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /fidelity-pass/);
  const passed = decideEntryTask({
    subagentType: "executor-low",
    gateState: { ...gateState, fidelity_pass: ["feat/t1"] },
    featureId: "feat",
    taskId: "t1",
  });
  assert.equal(passed.ok, true);
});

test("#ac-2.1 sniper of fix-mode (fresh session, empty fidelity_pass) is unconditionally allowed — sniper is EXEMPT like CC", () => {
  const decision = decideEntryTask({
    subagentType: "sniper-high",
    gateState: { mode: "FULL", feature_id: "feat" },
    featureId: "feat",
    taskId: "t1",
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.reason, "sniper-fidelity-exempt");
});

test("#ac-2.2 headless executor with fidelity stamped for a DIFFERENT task of the SAME feature is allowed (feature-level match, not task-exact)", () => {
  const decision = decideEntryTask({
    subagentType: "executor",
    gateState: { mode: "FULL", feature_id: "feat", fidelity_pass: ["feat/other-task@abc123"] },
    featureId: "feat",
    taskId: "t1",
  });
  assert.equal(decision.ok, true);
});

test("hasFidelityPass matches feature-only and feature/task qualified entries at feature granularity, ignores optional @sha", () => {
  assert.equal(hasFidelityPass(["feat/t1@abc123"], "feat"), true);
  assert.equal(hasFidelityPass(["feat/t1"], "feat"), true);
  assert.equal(hasFidelityPass(["feat"], "feat"), true);
  assert.equal(hasFidelityPass([], "feat"), false);
  assert.equal(hasFidelityPass(null, "feat"), false);
});

test("#ac-1.2 shipper with corrupt regate_pending (not a JSON array) denies fail-closed", () => {
  const decision = decideEntryTask({
    subagentType: "shipper",
    gateState: { mode: "FULL", regate_pending: "not-an-array" },
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /\[entry-gate\]/);
  assert.match(decision.reason, /gate-state corrupted/);
});

test("#ac-1.3 shipper with unmatched regate_pending (no regate_passed) denies with the instructive CC-shaped message", () => {
  const decision = decideEntryTask({
    subagentType: "shipper",
    gateState: { mode: "FULL", regate_pending: ["feat/t1"] },
  });
  assert.equal(decision.ok, false);
  assert.match(decision.reason, /\[entry-gate\]/);
  assert.match(decision.reason, /strong-eye re-gate/);
  assert.match(decision.reason, /feat\/t1/);
});

test("shipper with regate_pending matched by regate_passed (any sha suffix) is allowed", () => {
  const decision = decideEntryTask({
    subagentType: "shipper",
    gateState: { mode: "FULL", regate_pending: ["feat/t1"], regate_passed: ["feat/t1@abc123"] },
  });
  assert.equal(decision.ok, true);
});

test("shipper with no regate_pending at all is allowed", () => {
  const decision = decideEntryTask({ subagentType: "shipper", gateState: { mode: "FULL" } });
  assert.equal(decision.ok, true);
});

test("throwIfDenied throws only on deny, using the decision's own reason", () => {
  assert.doesNotThrow(() => throwIfDenied({ decision: "allow", reason: "ok" }));
  assert.throws(() => throwIfDenied({ decision: "deny", reason: "[entry-gate] nope" }), /\[entry-gate\] nope/);
});
