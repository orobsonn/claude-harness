/** @description Locked tests for classifyRegatePending. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyRegatePending,
  corruptRegatePendingReason,
} from "./regate-classify.mjs";

test("absent regate_pending → empty fail-open", () => {
  const r = classifyRegatePending({});
  assert.equal(r.corrupt, false);
  assert.deepEqual(r.pending, []);
});

test("array pending preserved", () => {
  const r = classifyRegatePending({ regate_pending: ["feat/t1"] });
  assert.equal(r.corrupt, false);
  assert.deepEqual(r.pending, ["feat/t1"]);
});

test("non-array string/object/null/number → corrupt with raw", () => {
  for (const raw of ["BROKEN", { x: 1 }, null, 42]) {
    const r = classifyRegatePending({ regate_pending: raw });
    assert.equal(r.corrupt, true);
    assert.equal(r.raw, raw);
  }
});

test("corrupt reason has gate-state corrupted token, not stamp regate-passed", () => {
  const reason = corruptRegatePendingReason("BROKEN");
  assert.match(reason, /gate-state corrupted/);
  assert.equal(reason.includes("stamp regate-passed"), false);
});
