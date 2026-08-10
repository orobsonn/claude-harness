/**
 * @description Tests for OC obs-emit pure decides + fail-open obsAppend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  eventForPipelineType,
  eventForPlanPath,
  eventForEyeRole,
  eventForHandRan,
  eventForTaskExecuting,
  parseEyeVerdict,
  bareEyeRole,
  obsAppend,
  resolveObsMetaPath,
  isEyeRole,
  isHandRole,
  isFullExecutionPlan,
  fullPlanExistsForRun,
  taskIndexFromPlan,
  dedupeByType,
  resolveHookArgs,
  extractTaskIds,
} from "./obs-emit.mjs";

test("eventForPipelineType normalizes modes", () => {
  assert.deepEqual(eventForPipelineType("full"), { type: "pipeline-type", mode: "FULL" });
  assert.deepEqual(eventForPipelineType("no-ceremony"), {
    type: "pipeline-type",
    mode: "NO-CEREMONY",
  });
});

test("eventForPlanPath anchored; rejects .state", () => {
  assert.deepEqual(eventForPlanPath(".opencode/plans/x/execution-plan.json"), {
    type: "plan-created",
  });
  assert.equal(eventForPlanPath("execution-plan.json"), null);
  assert.equal(eventForPlanPath(".opencode/plans/.state/s/execution-plan.json"), null);
});

test("fullPlanExistsForRun: scoped to session-feature; ignores other full plans", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-scope-"));
  try {
    const sid = "ses_abc";
    const fid = "feat-a";
    const other = join(dir, ".opencode/plans/old-other");
    const mine = join(dir, ".opencode/plans", `${sid}-${fid}`);
    mkdirSync(other, { recursive: true });
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(other, "execution-plan.json"), JSON.stringify({ tasks: [{ id: "x" }] }));
    writeFileSync(join(mine, "execution-plan.json"), JSON.stringify({ kind: "stub", tasks: [] }));
    assert.equal(
      fullPlanExistsForRun({ cwd: dir, sessionId: sid, featureId: fid }),
      false,
      "stub for this run",
    );
    writeFileSync(join(mine, "execution-plan.json"), JSON.stringify({ tasks: [{ id: "t1" }] }));
    assert.equal(fullPlanExistsForRun({ cwd: dir, sessionId: sid, featureId: fid }), true);
    // without session: fail closed
    assert.equal(fullPlanExistsForRun({ cwd: dir, sessionId: null, featureId: null }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("taskIndexFromPlan 1-based", () => {
  const dir = mkdtempSync(join(tmpdir(), "idx-"));
  try {
    const f = join(dir, "p.json");
    writeFileSync(f, JSON.stringify({ tasks: [{ id: "a" }, { id: "b" }] }));
    assert.deepEqual(taskIndexFromPlan(f, "b"), { n: 2, total: 2 });
    assert.equal(taskIndexFromPlan(f, "z"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isHandRole / isEyeRole", () => {
  assert.equal(isHandRole("executor-high"), true);
  assert.equal(isHandRole("sniper-medium"), true);
  assert.equal(isHandRole("test-author"), true);
  assert.equal(isHandRole("adversary"), false);
  for (const role of [
    "plan-reviewer-family-1",
    "plan-reviewer-family-2",
    "adversary-family-1",
    "adversary-family-2",
    "plan-reviewer",
    "plan-reviewer-openai",
    "adversary",
    "adversary-openai",
  ]) {
    assert.equal(isEyeRole(role), true, role);
  }
});

test("canonical and alias review eyes emit the same logical roles", () => {
  for (const role of [
    "plan-reviewer-family-1",
    "plan-reviewer-family-2",
    "plan-reviewer",
    "plan-reviewer-openai",
  ]) {
    assert.deepEqual(eventForEyeRole(role, "verdict: APPROVE"), {
      type: "plan-reviewed",
      verdict: "APPROVE",
      role: "plan-reviewer",
    });
  }
  for (const role of [
    "adversary-family-1",
    "adversary-family-2",
    "adversary",
    "adversary-openai",
  ]) {
    assert.deepEqual(eventForEyeRole(role, "{}", { planExists: false }), {
      type: "spec-adversary",
      role: "adversary",
    });
  }
});

test("eventForEyeRole adversary pre-plan", () => {
  assert.deepEqual(eventForEyeRole("adversary", "x", { planExists: false }), {
    type: "spec-adversary",
    role: "adversary",
  });
});

test("resolveHookArgs + extractTaskIds", () => {
  assert.deepEqual(
    resolveHookArgs({}, { args: { subagent_type: "executor-low", task_id: "t1" } }),
    { subagent_type: "executor-low", task_id: "t1" },
  );
  assert.deepEqual(
    extractTaskIds({ subagent_type: "executor-high", task_id: "t9", feature_id: "f", model: "m" }),
    { featureId: "f", taskId: "t9", model: "m", role: "executor-high" },
  );
});

test("dedupe task-executing by n", () => {
  assert.equal(
    dedupeByType([{ type: "task-executing", n: 1 }], { type: "task-executing", n: 1 }),
    true,
  );
  assert.equal(
    dedupeByType([{ type: "task-executing", n: 1 }], { type: "task-executing", n: 2 }),
    false,
  );
});

test("obsAppend fail-open", () => {
  assert.equal(obsAppend({ type: "x" }, { env: {} }), false);
  assert.equal(resolveObsMetaPath({}), null);
  assert.equal(eventForHandRan({ task: "t" }).type, "hand-ran");
  assert.equal(eventForTaskExecuting({ n: 1, total: 2 }).n, 1);
  assert.equal(parseEyeVerdict("verdict: APPROVE"), "APPROVE");
  assert.equal(bareEyeRole("@Foo/Bar"), "bar");
  assert.equal(isFullExecutionPlan("/nope"), false);
});

test("dedupe plan-reviewed by verdict; hand-ran by task", () => {
  assert.equal(
    dedupeByType([{ type: "plan-reviewed", verdict: "APPROVE" }], {
      type: "plan-reviewed",
      verdict: "APPROVE",
    }),
    true,
  );
  assert.equal(
    dedupeByType([{ type: "plan-reviewed", verdict: "APPROVE" }], {
      type: "plan-reviewed",
      verdict: "REVISE",
    }),
    false,
  );
  assert.equal(
    dedupeByType([{ type: "hand-ran", task: "t1" }], { type: "hand-ran", task: "t1" }),
    true,
  );
  assert.equal(
    dedupeByType([{ type: "final-review-done" }], { type: "final-review-done" }),
    true,
  );
});

test("dedupe starts over after attempt-started but remains strict inside its epoch", () => {
  const prior = [
    { type: "spec-created" },
    { type: "plan-created", tasks: 3 },
    { type: "task-executing", n: 1 },
    { type: "plan-reviewed", verdict: "APPROVE" },
    { type: "hand-ran", task: "task-1" },
    { type: "attempt-started", attempt: 2 },
  ];
  for (const event of [
    { type: "spec-created" },
    { type: "plan-created", tasks: 3 },
    { type: "task-executing", n: 1 },
    { type: "plan-reviewed", verdict: "APPROVE" },
    { type: "hand-ran", task: "task-1" },
  ]) assert.equal(dedupeByType(prior, event), false, `${event.type} restarts on attempt 2`);
  assert.equal(dedupeByType([...prior, { type: "plan-created", tasks: 3 }], { type: "plan-created", tasks: 3 }), true);
  assert.equal(dedupeByType([...prior, { type: "plan-created", tasks: 3 }], { type: "plan-created", tasks: 4 }), false);
});
