/**
 * @description Locked tests for gate-state-shape dual_status helpers.
 * dualStatusGatePatch rejects bare boolean and unknown strings;
 * isFullDualCoverage only true for both; merge never stores dual_completed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DUAL_STATUS,
  DUAL_STATUS_VALUES,
  isDualStatusEnum,
  isFullDualCoverage,
  isRecordedDualAttempt,
  dualStatusGatePatch,
  validateGateStateDualFields,
  mergeGateStatePatch,
} from "./gate-state-shape.mjs";

test("dual_status enum includes authoritative primary_only without treating it as full dual", () => {
  assert.equal(DUAL_STATUS_VALUES.size, 5);
  assert.ok(DUAL_STATUS_VALUES.has("both"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only_failopen"));
  assert.ok(DUAL_STATUS_VALUES.has("pending"));
  assert.ok(DUAL_STATUS_VALUES.has("primary_only_error"));
  assert.equal(isDualStatusEnum("both"), true);
  assert.equal(isDualStatusEnum(true), false);
  assert.equal(isDualStatusEnum(false), false);
  assert.equal(isDualStatusEnum("yes"), false);
});

test("isFullDualCoverage is true only for both — failopen is not full dual", () => {
  assert.equal(isFullDualCoverage(DUAL_STATUS.BOTH), true);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY_FAILOPEN), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PRIMARY_ONLY_ERROR), false);
  assert.equal(isFullDualCoverage(DUAL_STATUS.PENDING), false);
  assert.equal(isFullDualCoverage(undefined), false);
  assert.equal(isFullDualCoverage(true), false);
});

test("isRecordedDualAttempt excludes pending and missing", () => {
  assert.equal(isRecordedDualAttempt("both"), true);
  assert.equal(isRecordedDualAttempt("primary_only"), true);
  assert.equal(isRecordedDualAttempt("primary_only_failopen"), true);
  assert.equal(isRecordedDualAttempt("primary_only_error"), true);
  assert.equal(isRecordedDualAttempt("pending"), false);
  assert.equal(isRecordedDualAttempt(undefined), false);
});

test("dualStatusGatePatch rejects bare boolean true and unknown dual_status strings", () => {
  const badBool = dualStatusGatePatch(/** @type {any} */ (true));
  assert.equal(badBool.ok, false);
  assert.match(String(badBool.reason), /boolean|invalid dual_status/i);

  const badFalse = dualStatusGatePatch(/** @type {any} */ (false));
  assert.equal(badFalse.ok, false);

  const unknown = dualStatusGatePatch("yes");
  assert.equal(unknown.ok, false);
  assert.match(String(unknown.reason), /invalid dual_status/);

  const okBoth = dualStatusGatePatch("both");
  assert.equal("ok" in okBoth && okBoth.ok === false, false);
  assert.equal(/** @type {{ dual_status: string }} */ (okBoth).dual_status, "both");
  assert.equal("dual_completed" in okBoth, false);

  const okFailopen = dualStatusGatePatch("primary_only_failopen");
  assert.equal(
    /** @type {{ dual_status: string }} */ (okFailopen).dual_status,
    "primary_only_failopen",
  );
});

test("validateGateStateDualFields rejects dual_completed bare boolean", () => {
  const forged = validateGateStateDualFields({ dual_completed: true });
  assert.equal(forged.ok, false);
  assert.ok(forged.errors.some((e) => /dual_completed|boolean/i.test(e)));

  const forgedWithStatus = validateGateStateDualFields({
    dual_status: "both",
    dual_completed: true,
  });
  assert.equal(forgedWithStatus.ok, false);

  const valid = validateGateStateDualFields({ dual_status: "primary_only_failopen" });
  assert.equal(valid.ok, true);
  assert.equal(valid.errors.length, 0);
});

test("mergeGateStatePatch never stores dual_completed and applies dual_status enum only", () => {
  const rejected = mergeGateStatePatch({}, { dual_completed: true });
  assert.equal(rejected.ok, false);
  assert.match(String(rejected.reason), /dual_completed/);

  const badStatus = mergeGateStatePatch({}, { dual_status: true });
  assert.equal(badStatus.ok, false);

  const ok = mergeGateStatePatch(
    { feature_id: "oc-port-phase-2" },
    dualStatusGatePatch("both"),
  );
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.state.dual_status, "both");
    assert.equal("dual_completed" in ok.state, false);
  }

  const failopen = mergeGateStatePatch({}, dualStatusGatePatch("primary_only_failopen"));
  assert.equal(failopen.ok, true);
  if (failopen.ok) {
    assert.equal(failopen.state.dual_status, "primary_only_failopen");
    assert.equal(isFullDualCoverage(failopen.state.dual_status), false);
  }
});
