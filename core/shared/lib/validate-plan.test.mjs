/** @description Locked tests for validate-plan (T3 + #373 B1). Never-throw ValidationResult; expect stub|full|any; locked_tests {id,path,assertion}; complexity max. */
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
        {
          id: "t0-1",
          path: "core/__tests__/foo.test.mjs",
          assertion: "Given fixture, When validatePlan runs, Then ok is true",
        },
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
      {
        id: "a",
        severity: "low",
        scope_paths: [],
        criterion_refs: [],
        locked_tests: [{ id: "t", path: "t.test.mjs", assertion: "a" }],
        depends_on: ["b"],
      },
      {
        id: "b",
        severity: "low",
        scope_paths: [],
        criterion_refs: [],
        locked_tests: [{ id: "t", path: "t.test.mjs", assertion: "b" }],
        depends_on: ["a"],
      },
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

test("b1-assertion-required: locked_tests without assertion fail", () => {
  const plan = {
    feature_id: "no-assert",
    kind: "full",
    mode: "full",
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-1", path: "src/foo.test.ts" }],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("assertion required")));
});

test("b1-test-path-legacy: test_path without path fails with actionable message", () => {
  const plan = {
    feature_id: "legacy-lt",
    kind: "full",
    mode: "full",
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [
          {
            id: "lt-1",
            test_path: "src/foo.test.ts",
            assertion: "Given X When Y Then Z",
          },
        ],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes('use "path"') && e.includes("test_path")));
});

test("b1-fixture-paths-optional: valid fixture_paths accepted", () => {
  const plan = {
    feature_id: "with-fixtures",
    kind: "full",
    mode: "full",
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [
          {
            id: "lt-1",
            path: "test/import.test.ts",
            assertion: "Given sample CSV, When POST /import, Then imported: 3",
            fixture_paths: ["test/fixtures/sample.csv"],
          },
        ],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, true, res.errors?.join("; "));
});

test("b1-fixture-paths-hygiene: absolute fixture path rejected", () => {
  const plan = {
    feature_id: "bad-fixture",
    kind: "full",
    mode: "full",
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [
          {
            id: "lt-1",
            path: "test/import.test.ts",
            assertion: "x",
            fixture_paths: ["/etc/passwd"],
          },
        ],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("fixture_paths") && e.includes("repo-relative")));
});

test("b1-complexity-max: task and plan complexity max accepted", () => {
  const plan = {
    feature_id: "max-band",
    kind: "full",
    mode: "full",
    complexity: "max",
    tasks: [
      {
        id: "t1",
        severity: "high",
        complexity: "max",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [
          {
            id: "lt-1",
            path: "src/hard.test.ts",
            assertion: "Given hard case, When run, Then observable holds",
          },
        ],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, true, res.errors?.join("; "));
});

test("b1-complexity-invalid: unknown complexity rejected", () => {
  const plan = {
    feature_id: "bad-cx",
    kind: "full",
    mode: "full",
    tasks: [
      {
        id: "t1",
        severity: "low",
        complexity: "x-high",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [
          { id: "lt-1", path: "src/a.test.ts", assertion: "x" },
        ],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("complexity must be low|medium|high|max")));
});
