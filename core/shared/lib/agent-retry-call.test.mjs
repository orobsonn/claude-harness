import test from "node:test";
import assert from "node:assert/strict";
import { decideCallOutcomeOnce } from "./agent-retry-call.mjs";

test("error then after-success: only one failure, success ignored", () => {
  const m = new Map();
  const a = decideCallOutcomeOnce(m, "s::c1", "failure");
  assert.equal(a.apply, true);
  const b = decideCallOutcomeOnce(m, "s::c1", "success");
  assert.equal(b.apply, false);
  assert.equal(b.outcome, "failure");
});

test("double error event: second ignored", () => {
  const m = new Map();
  assert.equal(decideCallOutcomeOnce(m, "s::c1", "failure").apply, true);
  assert.equal(decideCallOutcomeOnce(m, "s::c1", "failure").apply, false);
});

test("after-success then error: upgrade to failure", () => {
  const m = new Map();
  assert.equal(decideCallOutcomeOnce(m, "s::c1", "success").apply, true);
  const u = decideCallOutcomeOnce(m, "s::c1", "failure");
  assert.equal(u.apply, true);
  assert.equal(u.undoSuccess, true);
});
