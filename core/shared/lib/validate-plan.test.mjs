/** @description Locked tests for validate-plan (T3 + #373 B1). Never-throw ValidationResult; expect stub|full|any; locked_tests {id,path,assertion}; complexity max. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePlan } from "./validate-plan.mjs";

const expectedModelStrategy = {
  hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
  planner: "openai/gpt-5.6-sol",
  "plan-reviewer": "openai/gpt-5.6-sol",
  compliance: "openai/gpt-5.6-sol",
  adversary: "openai/gpt-5.6-sol",
  security: "openai/gpt-5.6-sol",
  shipper: "openai/gpt-5.6-sol",
  harvester: "openai/gpt-5.6-sol",
};

const goldenFull = {
  feature_id: "oc-port-phase-1",
  kind: "full",
  mode: "full",
  model_strategy: expectedModelStrategy,
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

test("r15: full plans require the exact frozen model strategy", () => {
  const missing = validatePlan({ ...goldenFull, model_strategy: undefined }, { expect: "full" });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((error) => error.includes("model_strategy")));

  const legacy = validatePlan({
    ...goldenFull,
    model_strategy: { ...expectedModelStrategy, tiers: expectedModelStrategy.hand_tiers },
  }, { expect: "full", expectedModelStrategy });
  assert.equal(legacy.ok, false);
  assert.ok(legacy.errors.some((error) => error.includes("tiers")));

  const wrongHandTier = validatePlan({
    ...goldenFull,
    model_strategy: { ...expectedModelStrategy, hand_tiers: { ...expectedModelStrategy.hand_tiers, high: "other" } },
  }, { expect: "full", expectedModelStrategy });
  assert.equal(wrongHandTier.ok, false);
  assert.ok(wrongHandTier.errors.some((error) => error.includes("hand_tiers.high")));

  const wrongEye = validatePlan({
    ...goldenFull,
    model_strategy: { ...expectedModelStrategy, planner: "other/planner" },
  }, { expect: "full", expectedModelStrategy });
  assert.equal(wrongEye.ok, false);
  assert.ok(wrongEye.errors.some((error) => error.includes("planner")));

  const explicitUndefined = validatePlan(goldenFull, { expect: "full", expectedModelStrategy: undefined });
  assert.equal(explicitUndefined.ok, false);
  assert.ok(explicitUndefined.errors.some((error) => error.includes("expectedModelStrategy")));
});

test("r15: a runtime routing snapshot may freeze OpenAI hand tiers", () => {
  const runtimeStrategy = {
    ...expectedModelStrategy,
    hand_tiers: {
      low: "openai/gpt-5.6-luna",
      medium: "openai/gpt-5.6-luna",
      high: "openai/gpt-5.6-terra",
    },
  };
  const plan = { ...goldenFull, model_strategy: runtimeStrategy };

  const valid = validatePlan(plan, { expect: "full", expectedModelStrategy: runtimeStrategy });
  assert.equal(valid.ok, true, valid.errors.join("; "));

  const staleTier = validatePlan({
    ...plan,
    model_strategy: { ...runtimeStrategy, hand_tiers: expectedModelStrategy.hand_tiers },
  }, { expect: "full", expectedModelStrategy: runtimeStrategy });
  assert.equal(staleTier.ok, false);
  assert.ok(staleTier.errors.some((error) => error.includes("hand_tiers.low")));
});

test("r15: fallback is opaque and stubs do not require a strategy", () => {
  for (const fallback of [null, "opaque", ["opaque"], { provider: "opaque" }]) {
    const plan = { ...goldenFull, model_strategy: { ...expectedModelStrategy, fallback } };
    const result = validatePlan(plan, { expect: "full", expectedModelStrategy });
    assert.equal(result.ok, true, result.errors.join("; "));
    assert.deepEqual(plan.model_strategy.fallback, fallback);
  }
  assert.equal(validatePlan({ feature_id: "stub", kind: "stub", mode: "quick", tasks: [] }, { expect: "stub" }).ok, true);
});

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
    ...goldenFull,
    model_strategy: {
      ...expectedModelStrategy,
      tiers: { low: "haiku" },
    },
  };
  assert.doesNotThrow(() => {
    const res = validatePlan(legacy);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes("tiers")));
  });

  const badLegacyTiers = {
    ...goldenFull,
    model_strategy: { ...expectedModelStrategy, low: "claude-3" },
  };
  const r2 = validatePlan(badLegacyTiers);
  assert.equal(r2.ok, false);
});

test("b1-assertion-required: locked_tests without assertion fail", () => {
  const plan = {
    feature_id: "no-assert",
    kind: "full",
    mode: "full",
    model_strategy: expectedModelStrategy,
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
    model_strategy: expectedModelStrategy,
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
    model_strategy: expectedModelStrategy,
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
    model_strategy: expectedModelStrategy,
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

test("#ac-1.1 dangling depends_on: ghost task id → ok false with dangling ref", () => {
  const plan = {
    feature_id: "ghost-dep",
    kind: "full",
    mode: "full",
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "x" }],
        depends_on: ["ghost-task"],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("dangling ref") && e.includes("ghost-task")));
});

/**
 * @description Build a one-task full plan whose single task carries the given extra fields.
 * @param {Record<string, unknown>} taskOverrides
 * @returns {Record<string, unknown>}
 */
function planWithTask(taskOverrides) {
  return {
    feature_id: "model-resolved",
    kind: "full",
    mode: "full",
    model_strategy: expectedModelStrategy,
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "Given x, When y, Then z" }],
        ...taskOverrides,
      },
    ],
  };
}

test("#559 #ac-1.1 resolved_judgments_model_resolved as object → ok false naming the field", () => {
  const res = validatePlan(
    planWithTask({
      resolved_judgments: { ttl_seconds: 900 },
      resolved_judgments_model_resolved: { ttl_seconds: true },
    }),
    { expect: "full" }
  );
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes("task[0].resolved_judgments_model_resolved") && e.includes("array"))
  );
});

test("#559 #ac-1.1 resolved_judgments_model_resolved as number → ok false naming the field", () => {
  const res = validatePlan(
    planWithTask({
      resolved_judgments: { ttl_seconds: 900 },
      resolved_judgments_model_resolved: 3,
    }),
    { expect: "full" }
  );
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.includes("task[0].resolved_judgments_model_resolved") && e.includes("array"))
  );
});

test("#559 #ac-1.1 resolved_judgments_model_resolved with an empty item → ok false naming the field", () => {
  const res = validatePlan(
    planWithTask({
      resolved_judgments: { ttl_seconds: 900 },
      resolved_judgments_model_resolved: ["ttl_seconds", "   "],
    }),
    { expect: "full" }
  );
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some(
      (e) => e.includes("task[0].resolved_judgments_model_resolved[1]") && e.includes("non-empty string")
    )
  );
});

test("#559 #ac-1.2 resolved_judgments_model_resolved listing a key absent from the same task's resolved_judgments → ok false citing the orphan key", () => {
  const res = validatePlan(
    planWithTask({
      resolved_judgments: { ttl_seconds: 900 },
      resolved_judgments_model_resolved: ["algorithm"],
    }),
    { expect: "full" }
  );
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some(
      (e) => e.includes("task[0].resolved_judgments_model_resolved") && e.includes("algorithm")
    ),
    res.errors.join("; ")
  );
});

test("#559 #ac-1.2 a key resolved by ANOTHER task is still orphan on this task", () => {
  const plan = {
    feature_id: "cross-task",
    kind: "full",
    mode: "full",
    model_strategy: expectedModelStrategy,
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "x" }],
        resolved_judgments: { algorithm: "HS256" },
      },
      {
        id: "t2",
        severity: "low",
        scope_paths: ["src/"],
        criterion_refs: ["#ac-2"],
        locked_tests: [{ id: "lt-2", path: "src/b.test.ts", assertion: "y" }],
        resolved_judgments: { ttl_seconds: 900 },
        resolved_judgments_model_resolved: ["algorithm"],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some(
      (e) => e.includes("task[1].resolved_judgments_model_resolved") && e.includes("algorithm")
    ),
    res.errors.join("; ")
  );
});

test("#559 #ac-1.3 task without resolved_judgments_model_resolved → ok true (field is optional)", () => {
  const res = validatePlan(planWithTask({ resolved_judgments: { ttl_seconds: 900 } }), { expect: "full" });
  assert.equal(res.ok, true, res.errors?.join("; "));
});

test("#559 #ac-1.3 empty resolved_judgments_model_resolved → ok true, even with no resolved_judgments at all", () => {
  const withRj = validatePlan(
    planWithTask({ resolved_judgments: { ttl_seconds: 900 }, resolved_judgments_model_resolved: [] }),
    { expect: "full" }
  );
  assert.equal(withRj.ok, true, withRj.errors?.join("; "));

  const withoutRj = validatePlan(planWithTask({ resolved_judgments_model_resolved: [] }), {
    expect: "full",
  });
  assert.equal(withoutRj.ok, true, withoutRj.errors?.join("; "));
});

test("#559 #ac-1.3 every key present in resolved_judgments → ok true", () => {
  const res = validatePlan(
    planWithTask({
      resolved_judgments: { ttl_seconds: 900, algorithm: "HS256" },
      resolved_judgments_model_resolved: ["ttl_seconds", "algorithm"],
    }),
    { expect: "full" }
  );
  assert.equal(res.ok, true, res.errors?.join("; "));
});

test("#ac-1.2 empty scope_paths under expect full → ok false", () => {
  const plan = {
    feature_id: "empty-scope",
    kind: "full",
    mode: "full",
    tasks: [
      {
        id: "t1",
        severity: "low",
        scope_paths: [],
        criterion_refs: ["#ac-1"],
        locked_tests: [{ id: "lt-1", path: "src/a.test.ts", assertion: "x" }],
      },
    ],
  };
  const res = validatePlan(plan, { expect: "full" });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => e.includes("scope_paths") && e.includes("expect full")));
});
