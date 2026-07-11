/** @description Locked tests for validate-plan (T3). Never-throw ValidationResult; expect stub|full|any. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "./validate-plan.mjs";

const goldenFull = {
  feature_id: "oc-port-phase-1",
  kind: "full",
  mode: "full",
  tasks: [
    {
      id: "t0-skeleton",
      severity: "medium",
      complexity: "high",
      scope_paths: ["core/shared/"],
      criterion_refs: ["#ac-1.1"],
      locked_tests: [
        { id: "t0-1", path: "core/__tests__/foo.test.mjs" },
      ],
    },
  ],
};

test("t3-full-ok: golden valid full plan returns ok true", () => {
  const res = validatePlan(goldenFull);
  assert.equal(res.ok, true, res.errors?.join("; "));
  assert.deepEqual(res.errors, []);
});

test("t3-cycle: cycle in depends_on returns ok false", () => {
  const cyclic = {
    feature_id: "cyclic",
    kind: "full",
    mode: "full",
    tasks: [
      { id: "a", severity: "low", scope_paths: [], criterion_refs: [], locked_tests: [{id:"t",path:"t.test.mjs"}], depends_on: ["b"] },
      { id: "b", severity: "low", scope_paths: [], criterion_refs: [], locked_tests: [{id:"t",path:"t.test.mjs"}], depends_on: ["a"] },
    ],
  };
  const res = validatePlan(cyclic);
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("cycle")));
});

test("t3-stub: stub with empty tasks and expect stub returns ok true; expect full returns ok false", () => {
  const stub = {
    feature_id: "stub-feat",
    mode: "quick",
    tasks: [],
  };
  const okStub = validatePlan(stub, { expect: "stub" });
  assert.equal(okStub.ok, true);

  const notFull = validatePlan(stub, { expect: "full" });
  assert.equal(notFull.ok, false);
  assert.ok(notFull.errors.some((e) => e.includes("expect full but plan is not full")));
});

test("t3-tiers: legacy Claude tier names yield validation error without throw", () => {
  const legacy = {
    feature_id: "legacy",
    kind: "stub",
    mode: "quick",
    tasks: [],
    model_strategy: {
      tiers: { low: "haiku" },
    },
  };
  assert.doesNotThrow(() => {
    const res = validatePlan(legacy);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => /haiku|legacy|sonnet|opus/.test(e)));
  });

  const badLegacyTiers = {
    feature_id: "bad",
    kind: "stub",
    mode: "quick",
    tasks: [],
    model_strategy: { low: "claude-3" },
  };
  const r2 = validatePlan(badLegacyTiers);
  assert.equal(r2.ok, false);
});
