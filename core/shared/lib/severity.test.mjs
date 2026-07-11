/** @description Locked tests for severity (T4). Never throw. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { maxSeverity } from "./severity.mjs";

test("t4-severity: maxSeverity returns highest rank; empty list yields null without throw", () => {
  assert.equal(maxSeverity(["low", "high", "medium"]), "high");
  assert.equal(maxSeverity(["critical", "low"]), "critical");
  assert.equal(maxSeverity(["medium"]), "medium");

  const empty = maxSeverity([]);
  assert.equal(empty, null);

  const nonArray = maxSeverity(null);
  assert.equal(nonArray, null);

  assert.doesNotThrow(() => maxSeverity(undefined));
  assert.doesNotThrow(() => maxSeverity("not-array"));
});
