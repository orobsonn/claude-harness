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

test("QUICK/no-ceremony backstop blocks compliance/security/harvester/shipper, exempts executor", () => {
  for (const role of ["compliance", "security", "harvester", "shipper"]) {
    const decision = decideEntryTask({ subagentType: role, gateState: { mode: "QUICK" } });
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /\[entry-gate\]/);
    assert.match(decision.reason, new RegExp(role));
  }
  const executor = decideEntryTask({
    subagentType: "executor",
    gateState: { mode: "QUICK", fidelity_pass: ["feat/t1"] },
    featureId: "feat",
    taskId: "t1",
  });
  assert.equal(executor.ok, true);
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

test("adversary role allowed once ceremony present (caller stamps adversary_fired)", () => {
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

test("executor/sniper blocked until fidelity-pass for the task; unblocked once present", () => {
  const gateState = { mode: "FULL", feature_id: "feat" };
  for (const role of ["executor-low", "sniper-high"]) {
    const blocked = decideEntryTask({ subagentType: role, gateState, featureId: "feat", taskId: "t1" });
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason, /fidelity-pass/);
  }
  const passed = decideEntryTask({
    subagentType: "executor-low",
    gateState: { ...gateState, fidelity_pass: ["feat/t1"] },
    featureId: "feat",
    taskId: "t1",
  });
  assert.equal(passed.ok, true);
});

test("hasFidelityPass matches feature-only and feature/task qualified entries, ignores optional @sha", () => {
  assert.equal(hasFidelityPass(["feat/t1@abc123"], "feat", "t1"), true);
  assert.equal(hasFidelityPass(["feat/t1"], "feat", "t2"), false);
  assert.equal(hasFidelityPass(["feat"], "feat"), true);
  assert.equal(hasFidelityPass([], "feat"), false);
  assert.equal(hasFidelityPass(null, "feat"), false);
});

test("throwIfDenied throws only on deny, using the decision's own reason", () => {
  assert.doesNotThrow(() => throwIfDenied({ decision: "allow", reason: "ok" }));
  assert.throws(() => throwIfDenied({ decision: "deny", reason: "[entry-gate] nope" }), /\[entry-gate\] nope/);
});
