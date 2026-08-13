/** @description Single-evaluator gate-state shape and persisted legacy compatibility tests. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DUAL_STATUS,
  DUAL_STATUS_VALUES,
  dualStatusGatePatch,
  isDualStatusEnum,
  mergeGateStatePatch,
  normalizeDualStatus,
  validateGateStateDualFields,
} from "./gate-state-shape.mjs";

test("current dual_status writes are limited to done and pending", () => {
  assert.deepEqual([...DUAL_STATUS_VALUES].sort(), ["done", "pending"]);
  assert.deepEqual(DUAL_STATUS, { DONE: "done", PENDING: "pending" });
  assert.equal(isDualStatusEnum("done"), true);
  assert.equal(isDualStatusEnum("pending"), true);
  assert.equal(isDualStatusEnum("both"), false);
  assert.equal(isDualStatusEnum(true), false);
});

test("legacy scalar and map values preserve their prior lifecycle decision", () => {
  for (const value of ["both", "primary_only", "primary_only_failopen", "done"]) {
    assert.equal(normalizeDualStatus(value), "done");
  }
  assert.equal(normalizeDualStatus("primary_only_error"), "pending");
  assert.equal(normalizeDualStatus("pending"), "pending");
  assert.equal(normalizeDualStatus({ adversary: "both" }), "done");
  assert.equal(normalizeDualStatus({ plan_review: "both", adversary: "both" }), "done");
  assert.equal(normalizeDualStatus({ plan_review: "both", adversary: null }), "done");
  assert.equal(normalizeDualStatus({ plan_review: "both", adversary: "pending" }), "done");
  assert.equal(normalizeDualStatus({ executor: "both" }), undefined);
  assert.equal(normalizeDualStatus("unknown"), undefined);
});

test("new patches reject legacy writer values and bare booleans", () => {
  assert.deepEqual(dualStatusGatePatch("done"), { dual_status: "done" });
  assert.deepEqual(dualStatusGatePatch("pending"), { dual_status: "pending" });
  assert.equal(dualStatusGatePatch("both").ok, false);
  assert.equal(dualStatusGatePatch(true).ok, false);
  assert.equal(mergeGateStatePatch({}, { dual_status: "both" }).ok, false);
  assert.equal(mergeGateStatePatch({}, { dual_status: true }).ok, false);
});

test("unrelated patches preserve persisted legacy state; current status overwrites it", () => {
  const legacy = { dual_status: { plan_review: "both", adversary: "both" }, hand_quarantine: ["a/b"] };
  const unrelated = mergeGateStatePatch(legacy, { hand_quarantine: ["c/d"] });
  assert.equal(unrelated.ok, true);
  assert.deepEqual(unrelated.state.dual_status, legacy.dual_status);
  assert.deepEqual(unrelated.state.hand_quarantine, ["a/b", "c/d"]);

  const current = mergeGateStatePatch(legacy, { dual_status: "done" });
  assert.equal(current.ok, true);
  assert.equal(current.state.dual_status, "done");
});

test("validation rejects forged fields but accepts every persisted legacy enum", () => {
  assert.equal(validateGateStateDualFields({ dual_completed: true }).ok, false);
  assert.equal(validateGateStateDualFields({ dual_status: true }).ok, false);
  assert.equal(validateGateStateDualFields({ dual_status: { plan_review: "unknown" } }).ok, false);
  for (const dual_status of ["both", "primary_only", "primary_only_failopen", "primary_only_error", "pending"]) {
    assert.equal(validateGateStateDualFields({ dual_status }).ok, true, dual_status);
  }
});

test("plan verdict validation remains patch-scoped", () => {
  assert.equal(mergeGateStatePatch({}, { plan_verdict: "APPROVE" }).ok, true);
  assert.equal(mergeGateStatePatch({}, { plan_verdict: "REVISE" }).ok, true);
  assert.equal(mergeGateStatePatch({}, { plan_verdict: "MAYBE" }).ok, false);
  assert.equal(mergeGateStatePatch({ plan_verdict: "legacy-invalid" }, { hand_quarantine: ["a/b"] }).ok, true);
});
