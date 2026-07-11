/**
 * @description Contract tests for mem-guard.mjs — the pure predicate that decides whether the VPS
 * runtime has enough free memory to proceed with a dispatch, and its default threshold constant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasEnoughFreeMemory, DEFAULT_MEM_GUARD_BYTES } from "./mem-guard.mjs";

test("hasEnoughFreeMemory: freeBytes below thresholdBytes returns false (abort)", () => {
  const result = hasEnoughFreeMemory({ freeBytes: 524288000, thresholdBytes: 805306368 });
  assert.strictEqual(result, false);
});

test("hasEnoughFreeMemory: freeBytes equal to thresholdBytes returns true (proceed)", () => {
  const result = hasEnoughFreeMemory({ freeBytes: 805306368, thresholdBytes: 805306368 });
  assert.strictEqual(result, true);
});

test("hasEnoughFreeMemory: non-finite freeBytes (null or NaN) fails open and returns true", () => {
  const withNull = hasEnoughFreeMemory({ freeBytes: null, thresholdBytes: 805306368 });
  const withNaN = hasEnoughFreeMemory({ freeBytes: NaN, thresholdBytes: 805306368 });
  assert.strictEqual(withNull, true);
  assert.strictEqual(withNaN, true);
});

test("hasEnoughFreeMemory: disabled threshold (0 or NaN) returns true regardless of freeBytes", () => {
  const withZeroThreshold = hasEnoughFreeMemory({ freeBytes: 0, thresholdBytes: 0 });
  const withNaNThreshold = hasEnoughFreeMemory({ freeBytes: 0, thresholdBytes: NaN });
  assert.strictEqual(withZeroThreshold, true);
  assert.strictEqual(withNaNThreshold, true);
});

test("hasEnoughFreeMemory: genuine finite freeBytes=0 below a positive threshold returns false", () => {
  const result = hasEnoughFreeMemory({ freeBytes: 0, thresholdBytes: 805306368 });
  assert.strictEqual(result, false);
});

test("DEFAULT_MEM_GUARD_BYTES: equals exactly 805306368 (768 MiB)", () => {
  assert.strictEqual(DEFAULT_MEM_GUARD_BYTES, 805306368);
});
