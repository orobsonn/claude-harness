/**
 * @description Contract tests for mem-guard.mjs — the pure predicate that decides whether the VPS
 * runtime has enough free memory to proceed with a dispatch, and its default threshold constant.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { hasEnoughFreeMemory, readMemGuardBytesFromEnv, DEFAULT_MEM_GUARD_BYTES } from "./mem-guard.mjs";

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

test("readMemGuardBytesFromEnv: parses a finite HARNESS_MEM_GUARD_BYTES value", () => {
  const result = readMemGuardBytesFromEnv({ HARNESS_MEM_GUARD_BYTES: "1073741824" });
  assert.strictEqual(result, 1073741824);
});

test("readMemGuardBytesFromEnv: parses '0' to disable the guard via the fail-open branch", () => {
  const result = readMemGuardBytesFromEnv({ HARNESS_MEM_GUARD_BYTES: "0" });
  assert.strictEqual(result, 0);
});

test("readMemGuardBytesFromEnv: unset variable returns undefined", () => {
  const result = readMemGuardBytesFromEnv({});
  assert.strictEqual(result, undefined);
});

test("readMemGuardBytesFromEnv: empty-string or non-numeric value returns undefined", () => {
  const withEmpty = readMemGuardBytesFromEnv({ HARNESS_MEM_GUARD_BYTES: "" });
  const withGarbage = readMemGuardBytesFromEnv({ HARNESS_MEM_GUARD_BYTES: "not-a-number" });
  assert.strictEqual(withEmpty, undefined);
  assert.strictEqual(withGarbage, undefined);
});
