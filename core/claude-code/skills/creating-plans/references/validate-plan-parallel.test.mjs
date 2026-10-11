/**
 * @description Contract tests for the opt-in parallel execution rules of validate-plan.mjs
 * (`"execution": {"parallel": true}`): disjoint literal scopes for tasks that can run together,
 * explicit depends_on, the claude hand ladder and the `no_tests` escape. Plans without `execution`
 * keep validating exactly as before.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateExecutionPlan } from "./validate-plan.mjs";

const VALIDATOR = join(dirname(fileURLToPath(import.meta.url)), "validate-plan.mjs");

function task(id, scope, extra = {}) {
  return {
    id,
    spec: `do ${id}`,
    severity: "low",
    scope_paths: scope,
    resolved_judgments: { k: "v" },
    criterion_refs: ["#ac-1.1"],
    locked_tests: [{ test_path: `test/${id}.test.mjs`, assertion: "Given X When Y Then Z" }],
    adversarial: { enabled: false },
    depends_on: [],
    ...extra,
  };
}

function plan(tasks, extra = {}) {
  return {
    version: "1.0",
    feature_id: "demo-feature",
    created_at: "2026-10-11T00:00:00Z",
    mode: "full",
    model_strategy: {
      hand_tiers: { low: "haiku", medium: "sonnet", high: "sonnet" },
      planner: "opus",
      "plan-reviewer": "opus",
      compliance: "sonnet",
      adversary: "opus",
      security: "opus",
      shipper: "sonnet",
      harvester: "sonnet",
    },
    tasks,
    final_review: { compliance: true, adversary: true },
    demo: { type: "markdown", scenarios_from_refs: ["#ac-1.1"] },
    execution: { parallel: true },
    ...extra,
  };
}

const messages = (result) => result.errors.map((e) => `[${e.path}] ${e.message}`).join("\n");

test("a disjoint parallel plan is valid through the module and the unchanged CLI", () => {
  const valid = plan([task("a", ["src/a"]), task("b", ["src/b"]), task("c", ["src/a/extra.mjs"], { depends_on: ["a"] })]);
  const result = validateExecutionPlan(valid);
  assert.equal(result.ok, true, messages(result));
  const dir = mkdtempSync(join(tmpdir(), "validate-plan-parallel-"));
  try {
    writeFileSync(join(dir, "plan.json"), JSON.stringify(valid));
    const run = spawnSync(process.execPath, [VALIDATOR, join(dir, "plan.json")], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "OK\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("independent tasks with overlapping scope, locked test or fixture are rejected", () => {
  for (const [label, b] of [
    ["scope", task("b", ["src/a/inner.mjs"])],
    ["locked test", task("b", ["src/b"], { locked_tests: [{ test_path: "src/a/b.test.mjs", assertion: "Given When Then" }] })],
    ["fixture", task("b", ["src/b"], { locked_tests: [{ test_path: "test/b.test.mjs", assertion: "Given When Then", fixture_paths: ["src/a/fx.json"] }] })],
    ["repo root", task("b", ["."])],
  ]) {
    const result = validateExecutionPlan(plan([task("a", ["src/a"]), b]));
    assert.equal(result.ok, false, label);
    assert.match(messages(result), /tasks "a" and "b" can run in parallel but their scopes overlap/, label);
  }
});

test("component-wise prefixes do not overlap and ancestry (even transitive) allows sharing scope", () => {
  assert.equal(validateExecutionPlan(plan([task("a", ["src/a"]), task("b", ["src/ab"])])).ok, true);
  const chain = plan([
    task("a", ["src/a"]),
    task("b", ["src/b"], { depends_on: ["a"] }),
    task("c", ["src/a/c.mjs"], { depends_on: ["b"] }),
  ]);
  assert.equal(validateExecutionPlan(chain).ok, true, messages(validateExecutionPlan(chain)));
});

test("globs and unsafe paths are rejected in a parallel plan", () => {
  for (const scope of [["src/*.mjs"], ["src/{a,b}"], ["src/{1..3}"], ["src/a?"], ["../outside"], ["/abs"], ["src\\win"]]) {
    const result = validateExecutionPlan(plan([task("a", scope)]));
    assert.equal(result.ok, false, scope[0]);
    assert.match(messages(result), /\[tasks\[0\]\.scope_paths\] task scope/, scope[0]);
  }
  assert.equal(validateExecutionPlan(plan([task("a", ["app/[slug]/page.tsx"])])).ok, true);
});

test("a parallel plan requires depends_on on every task and the claude hand ladder", () => {
  const { depends_on: _drop, ...noDeps } = task("a", ["src/a"]);
  assert.match(messages(validateExecutionPlan(plan([noDeps]))), /\[tasks\[0\]\.depends_on\] is required in a parallel plan/);
  const ollama = plan([task("a", ["src/a"])]);
  ollama.model_strategy.hand_tiers = { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" };
  assert.match(messages(validateExecutionPlan(ollama)), /require the claude hand family ladder/);
});

test("no_tests is valid only in a parallel plan and only with an empty locked_tests", () => {
  const ok = plan([task("a", ["src/a"], { no_tests: true, locked_tests: [] })]);
  assert.equal(validateExecutionPlan(ok).ok, true, messages(validateExecutionPlan(ok)));
  const withTests = plan([task("a", ["src/a"], { no_tests: true })]);
  assert.match(messages(validateExecutionPlan(withTests)), /must be \[\] when no_tests is true/);
  const serial = plan([task("a", ["src/a"], { no_tests: true, locked_tests: [] })]);
  delete serial.execution;
  const serialResult = messages(validateExecutionPlan(serial));
  assert.match(serialResult, /no_tests\] is only valid in a parallel plan/);
  assert.match(serialResult, /locked_tests\] must have at least 1 item/);
});

test("plans without execution keep the previous rules: overlap and missing depends_on are fine", () => {
  const serial = plan([task("a", ["src/a"]), task("b", ["src/a"])]);
  delete serial.execution;
  delete serial.tasks[0].depends_on;
  serial.model_strategy.hand_tiers = { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" };
  assert.equal(validateExecutionPlan(serial).ok, true, messages(validateExecutionPlan(serial)));
});

test("execution is a strict object", () => {
  assert.match(messages(validateExecutionPlan(plan([task("a", ["src/a"])], { execution: { parallel: "yes" } }))), /execution\.parallel\] must be a boolean/);
  assert.match(messages(validateExecutionPlan(plan([task("a", ["src/a"])], { execution: { parallel: true, max: 3 } }))), /execution\.max\] unknown key/);
  assert.match(messages(validateExecutionPlan(plan([task("a", ["src/a"])], { execution: [] }))), /\[execution\] must be an object/);
  assert.equal(validateExecutionPlan(plan([task("a", ["src/a"]), task("b", ["src/a"])], { execution: { parallel: false } })).ok, true);
});
