/** @description Prevents OpenCode-only resume, planner-FSM, todo and session-scoped plan engines from returning. */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { decide as decidePlanWrite } from "./lib/plan-write-decide.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const opencodeRoot = join(root, "core", "opencode");

const retiredRuntimePaths = [
  "lib/feature-resume.mjs",
  "lib/classify-resume.mjs",
  "lib/planner-state.mjs",
  "lib/planner-artifact.mjs",
  "lib/runtime-todo-projection.mjs",
  "lib/todo-projection.mjs",
  "plugin/lib/planner-brief.mjs",
  "plugin/lib/planner-result.mjs",
  "plugin/planner-recovery.ts",
  "tools/sync-harness-todo.ts",
  "plugin/lib/bound-plan.mjs",
];

const retiredRuntimeLanguage = [
  "feature-resume",
  "classify-resume",
  "planner-recovery",
  "planner-state",
  "planner-artifact",
  "runtime-todo-projection",
  "todo-projection",
  "sync-harness-todo",
  "bound-plan",
  "bound plan",
];

function runtimeFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return runtimeFiles(path);
    return /\.(?:mjs|ts)$/.test(entry.name) && !entry.name.includes(".test.") ? [path] : [];
  });
}

test("only the planner may author the feature-stable plan", () => {
  const plan = { tool_input: { file_path: ".opencode/plans/feature-a/execution-plan.json" } };

  assert.equal(decidePlanWrite(plan, { actingRole: "planner" }).allow, true);
  assert.equal(decidePlanWrite(plan, { actingRole: "build" }).allow, false);
});

test("OpenCode runtime keeps one feature-stable planner-authored plan without resume, todo or bound-plan engines", () => {
  const violations = [];

  for (const path of retiredRuntimePaths) {
    if (existsSync(join(opencodeRoot, path))) violations.push(`retired runtime path remains: ${path}`);
  }

  for (const file of runtimeFiles(opencodeRoot)) {
    const source = readFileSync(file, "utf8");
    const name = relative(root, file);
    for (const phrase of retiredRuntimeLanguage) {
      if (source.toLowerCase().includes(phrase)) violations.push(`${name}: removed engine language remains: ${phrase}`);
    }
    if (/\.opencode["'`]?\s*,\s*["'`]plans["'`]?\s*,\s*`?\$\{[^}]*session/i.test(source)) {
      violations.push(`${name}: session-scoped feature plan path remains`);
    }
    if (/plans\/<(?:session|sessionid)|\$\{(?:session|sessionID)[^}]*\}-\$\{(?:feature|featureId)/i.test(source)) {
      violations.push(`${name}: session-scoped feature plan layout remains`);
    }
  }

  assert.deepEqual(violations, [], violations.join("\n"));
});
