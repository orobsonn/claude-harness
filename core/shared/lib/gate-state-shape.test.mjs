/** @description Locked tests for gate-state-shape — markers and counters validation. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyGateStatePatch,
  validateGateStateShape,
  emptyGateState,
  unionMarkers,
} from "./gate-state-shape.mjs";

test("t5-shape: gate-state shape validates markers and counters", () => {
  const good = emptyGateState({
    session_id: "ses_1",
    feature_id: "feat-a",
    mode: "LIGHT",
    fidelity_pass: ["feat-a/task-1"],
    plan_review_count: 1,
    adversary_loop_count: 0,
  });
  const v = validateGateStateShape(good);
  assert.equal(v.ok, true, v.errors?.join("; "));
  assert.deepEqual(v.errors, []);
});

test("validateGateStateShape rejects non-array markers", () => {
  const v = validateGateStateShape({ fidelity_pass: "not-array" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("fidelity_pass")));
});

test("validateGateStateShape rejects negative counters", () => {
  const v = validateGateStateShape({ plan_review_count: -1 });
  assert.equal(v.ok, false);
});

test("validateGateStateShape rejects invalid dual_status", () => {
  const v = validateGateStateShape({ dual_status: true });
  assert.equal(v.ok, false);
  const v2 = validateGateStateShape({ dual_status: "both" });
  assert.equal(v2.ok, true);
});

test("applyGateStatePatch unions marker arrays (no drop)", () => {
  const r = applyGateStatePatch(
    { fidelity_pass: ["a/t1"], hand_finished: ["a/t1"] },
    { fidelity_pass: ["a/t2"], brainstormed: true },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.fidelity_pass, ["a/t1", "a/t2"]);
  assert.deepEqual(r.state.hand_finished, ["a/t1"]);
  assert.equal(r.state.brainstormed, true);
});

test("unionMarkers dedups", () => {
  assert.deepEqual(unionMarkers(["x", "y"], ["y", "z"]), ["x", "y", "z"]);
});

test("applyGateStatePatch never throws", () => {
  assert.doesNotThrow(() => applyGateStatePatch(null, null));
  assert.equal(applyGateStatePatch(null, null).ok, false);
});
