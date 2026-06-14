/**
 * @description Contract tests for validate-plan.mjs model_strategy shapes —
 * the hands/eyes split. Each case writes a temp plan fixture, spawns the
 * validator CLI, and asserts on exit code + emitted error paths. No deps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATOR = join(HERE, "validate-plan.mjs");

/** @description Runs the validator CLI against a plan object written to a temp file. */
function runValidator(plan) {
  const dir = mkdtempSync(join(tmpdir(), "validate-plan-"));
  const file = join(dir, "plan.json");
  try {
    writeFileSync(file, JSON.stringify(plan), "utf8");
    const res = spawnSync(process.execPath, [VALIDATOR, file], {
      encoding: "utf8",
    });
    return { status: res.status, stdout: res.stdout, stderr: res.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FIXED_EYE_ROLES = {
  planner: "opus",
  "plan-reviewer": "opus",
  compliance: "sonnet",
  adversary: "opus",
  security: "opus",
  shipper: "sonnet",
  harvester: "sonnet",
};

/** @description Builds a minimal otherwise-valid plan, merging the given model_strategy. */
function basePlan(modelStrategy) {
  return {
    version: "1.0",
    feature_id: "demo-feature",
    created_at: "2026-06-12T00:00:00Z",
    mode: "full",
    model_strategy: modelStrategy,
    tasks: [
      {
        id: "t1",
        spec: "do the thing",
        severity: "low",
        scope_paths: ["src/foo.ts"],
        resolved_judgments: { k: "v" },
        criterion_refs: ["#ac-1.1"],
        locked_tests: [
          { test_path: "src/foo.test.ts", assertion: "Given X When Y Then Z" },
        ],
        adversarial: { enabled: false },
      },
    ],
    final_review: { compliance: true, adversary: true },
    demo: { type: "markdown", scenarios_from_refs: ["#ac-1.1"] },
  };
}

const SPLIT_HAND_TIERS = { low: "kimi-k2.6", medium: "qwen-3", high: "deepseek-v3" };

test("split-shape eye role set to an Ollama id is rejected on the role path", () => {
  const plan = basePlan({
    hand_tiers: SPLIT_HAND_TIERS,
    ...FIXED_EYE_ROLES,
    compliance: "kimi-k2.6",
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy\.compliance/);
});

test("valid split-shape plan (hand_tiers + Claude-alias eyes, no legacy tiers) prints OK", () => {
  const plan = basePlan({
    hand_tiers: SPLIT_HAND_TIERS,
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /OK/);
});

test("legacy plan (single tiers, no hand_tiers) stays valid — back-compat", () => {
  const plan = basePlan({
    tiers: { low: "haiku", medium: "sonnet", high: "opus" },
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /OK/);
});

test("both hand_tiers AND legacy tiers present is rejected as mutually exclusive", () => {
  const plan = basePlan({
    tiers: { low: "haiku", medium: "sonnet", high: "opus" },
    hand_tiers: SPLIT_HAND_TIERS,
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy/);
  assert.match(r.stderr, /mutually exclusive/i);
});

test("split-shape plan missing hand_tiers.medium is rejected on that path", () => {
  const plan = basePlan({
    hand_tiers: { low: "kimi-k2.6", high: "deepseek-v3" },
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy\.hand_tiers\.medium/);
});

test("executor as an explicit model_strategy key is forbidden (split shape)", () => {
  const plan = basePlan({
    hand_tiers: SPLIT_HAND_TIERS,
    ...FIXED_EYE_ROLES,
    executor: "kimi-k2.6",
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy\.executor/);
});

test("sniper as an explicit model_strategy key is forbidden (legacy shape)", () => {
  const plan = basePlan({
    tiers: { low: "haiku", medium: "sonnet", high: "opus" },
    ...FIXED_EYE_ROLES,
    sniper: "haiku",
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy\.sniper/);
});

// DEFECT 1 — table-driven: all 7 eye roles must reject an Ollama id
test("all 7 eye roles set to an Ollama id are each individually rejected (table-driven)", () => {
  const ALL_FIXED_ROLES = [
    "planner",
    "plan-reviewer",
    "compliance",
    "adversary",
    "security",
    "shipper",
    "harvester",
  ];
  for (const role of ALL_FIXED_ROLES) {
    const plan = basePlan({
      hand_tiers: SPLIT_HAND_TIERS,
      ...FIXED_EYE_ROLES,
      [role]: "kimi-k2.6",
    });
    const r = runValidator(plan);
    assert.notEqual(r.status, 0, `role "${role}": must exit non-zero`);
    assert.match(
      r.stderr,
      new RegExp(`model_strategy\\.${role}`),
      `role "${role}": stderr must mention model_strategy.${role}`
    );
  }
});

// DEFECT 2 — #ac-2.2 NEITHER clause: no tiers and no hand_tiers must be rejected
test("model_strategy with neither tiers nor hand_tiers is rejected (#ac-2.2 NEITHER clause)", () => {
  const plan = basePlan({ ...FIXED_EYE_ROLES });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy/);
  assert.match(r.stderr, /must provide exactly one of tiers/);
});

// DEFECT 3 — unknown key allowlist: eye_tiers was intentionally dropped
test("model_strategy with eye_tiers key is rejected as unknown key", () => {
  const plan = basePlan({
    hand_tiers: SPLIT_HAND_TIERS,
    ...FIXED_EYE_ROLES,
    eye_tiers: { low: "opus", medium: "sonnet", high: "haiku" },
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy\.eye_tiers/);
  assert.match(r.stderr, /unknown key/);
});

// DEFECT 4a — absent eye role is rejected as required fixed role
test("eye role absent from model_strategy is rejected as required fixed role", () => {
  const { compliance: _dropped, ...withoutCompliance } = FIXED_EYE_ROLES;
  const plan = basePlan({
    hand_tiers: SPLIT_HAND_TIERS,
    ...withoutCompliance,
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy\.compliance/);
  assert.match(r.stderr, /required fixed role/);
});

// task.id must be kebab-case (same shape mark.mjs accepts) — a non-kebab id (e.g.
// underscore 'auth_login') would make the re-gate stamp silently fail → fail-OPEN block.
test("task.id with an underscore ('auth_login') is rejected on the tasks[0].id path", () => {
  const plan = basePlan({ hand_tiers: SPLIT_HAND_TIERS, ...FIXED_EYE_ROLES });
  plan.tasks[0].id = "auth_login";
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /tasks\[0\]\.id/);
  assert.match(r.stderr, /kebab-case/);
});

// locked_test.fixture_paths is OPTIONAL: when present it must be a non-empty array of
// non-empty strings (the enumerated fixtures the test-author writes, captured in the manifest).
test("locked_test with a valid fixture_paths array prints OK", () => {
  const plan = basePlan({ hand_tiers: SPLIT_HAND_TIERS, ...FIXED_EYE_ROLES });
  plan.tasks[0].locked_tests[0].fixture_paths = [
    "src/__fixtures__/input.json",
    "src/__fixtures__/expected.json",
  ];
  const r = runValidator(plan);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}: ${r.stderr}`);
  assert.match(r.stdout, /OK/);
});

test("locked_test with a malformed fixture_paths (empty-string entry) is rejected on that path", () => {
  const plan = basePlan({ hand_tiers: SPLIT_HAND_TIERS, ...FIXED_EYE_ROLES });
  plan.tasks[0].locked_tests[0].fixture_paths = ["src/__fixtures__/input.json", ""];
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /tasks\[0\]\.locked_tests\[0\]\.fixture_paths\[1\]/);
  assert.match(r.stderr, /non-empty/);
});

test("locked_test with fixture_paths that is not an array is rejected", () => {
  const plan = basePlan({ hand_tiers: SPLIT_HAND_TIERS, ...FIXED_EYE_ROLES });
  plan.tasks[0].locked_tests[0].fixture_paths = "src/__fixtures__/input.json";
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /tasks\[0\]\.locked_tests\[0\]\.fixture_paths/);
  assert.match(r.stderr, /must be an array/);
});

// DEFECT 4b — empty string hand_tiers value is rejected (non-empty model id required)
test("hand_tiers value of empty string is rejected (non-empty model id required)", () => {
  const plan = basePlan({
    hand_tiers: { low: "", medium: "qwen-3", high: "deepseek-v3" },
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.notEqual(r.status, 0, "must exit non-zero");
  assert.match(r.stderr, /model_strategy\.hand_tiers\.low/);
  assert.match(r.stderr, /non-empty/);
});

// TRILHO 2 — legacy warning rail
// A valid split (hand_tiers) plan emits NO legacy warning.
test("valid hand_tiers plan → exit 0 and NO legacy warning on stderr", () => {
  const plan = basePlan({
    hand_tiers: { low: "glm-5.1", medium: "deepseek-v4-pro", high: "kimi-2.7" },
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.equal(r.status, 0, "valid split plan must exit 0");
  assert.doesNotMatch(r.stderr, /legacy/i, "no legacy warning for hand_tiers plan");
});

// A valid legacy (tiers only) plan still validates but warns about Claude-only hands.
test("valid legacy tiers plan → exit 0 and a legacy/Claude-hands warning on stderr", () => {
  const plan = basePlan({
    tiers: { low: "haiku", medium: "sonnet", high: "opus" },
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.equal(r.status, 0, "valid legacy plan still exits 0");
  assert.match(r.stderr, /legacy/i, "legacy warning must name the risk");
});

// Non-regression: the warning never becomes a reject — legacy plan still prints OK.
test("valid legacy tiers plan → not rejected (stdout OK, exit 0)", () => {
  const plan = basePlan({
    tiers: { low: "haiku", medium: "sonnet", high: "opus" },
    ...FIXED_EYE_ROLES,
  });
  const r = runValidator(plan);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /OK/);
});
