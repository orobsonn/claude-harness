/**
 * @description Tests for OC obs-emit pure decides + fail-open obsAppend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
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
  isFullExecutionPlan,
  dedupeByType,
  resolveHookArgs,
} from "./obs-emit.mjs";

test("eventForPipelineType normalizes modes", () => {
  assert.deepEqual(eventForPipelineType("full"), { type: "pipeline-type", mode: "FULL" });
  assert.deepEqual(eventForPipelineType("LIGHT"), { type: "pipeline-type", mode: "LIGHT" });
  assert.deepEqual(eventForPipelineType("no-ceremony"), {
    type: "pipeline-type",
    mode: "NO-CEREMONY",
  });
  assert.equal(eventForPipelineType(""), null);
});

test("eventForPlanPath: anchored under .opencode/plans; rejects .state and bare basename", () => {
  assert.deepEqual(eventForPlanPath(".opencode/plans/x/execution-plan.json"), {
    type: "plan-created",
  });
  assert.deepEqual(eventForPlanPath("/w/.opencode/plans/f/spec.md"), { type: "spec-created" });
  assert.equal(eventForPlanPath("execution-plan.json"), null);
  assert.equal(eventForPlanPath(".opencode/plans/.state/s/execution-plan.json"), null);
  assert.equal(eventForPlanPath("README.md"), null);
});

test("isFullExecutionPlan: stub empty tasks vs full", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-full-"));
  try {
    const stub = join(dir, "stub.json");
    const full = join(dir, "full.json");
    writeFileSync(stub, JSON.stringify({ kind: "stub", tasks: [] }));
    writeFileSync(full, JSON.stringify({ tasks: [{ id: "t1" }] }));
    assert.equal(isFullExecutionPlan(stub), false);
    assert.equal(isFullExecutionPlan(full), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eventForEyeRole: plan-reviewer verdict; adversary pre-plan", () => {
  assert.deepEqual(eventForEyeRole("plan-reviewer", "verdict: APPROVE"), {
    type: "plan-reviewed",
    verdict: "APPROVE",
    role: "plan-reviewer",
  });
  assert.deepEqual(eventForEyeRole("adversary", "x", { planExists: false }), {
    type: "spec-adversary",
    role: "adversary",
  });
  assert.deepEqual(eventForEyeRole("security", "ok", { planExists: true }), {
    type: "eye",
    role: "security",
  });
  assert.equal(eventForEyeRole("executor-high", "x"), null);
  assert.equal(isEyeRole("adversary-openai"), true);
  assert.equal(bareEyeRole("@plan-reviewer"), "plan-reviewer");
  assert.equal(parseEyeVerdict("REVISE please"), "REVISE");
});

test("eventForHandRan / task-executing validation", () => {
  assert.deepEqual(eventForHandRan({ task: "t1", model: "m" }), {
    type: "hand-ran",
    task: "t1",
    model: "m",
  });
  assert.equal(eventForHandRan({}), null);
  assert.deepEqual(eventForTaskExecuting({ n: 1, total: 3 }), {
    type: "task-executing",
    n: 1,
    total: 3,
  });
  assert.equal(eventForTaskExecuting({ n: 0, total: 3 }), null);
});

test("resolveHookArgs prefers output.args (OC contract)", () => {
  assert.deepEqual(
    resolveHookArgs({ args: { a: 1 } }, { args: { subagent_type: "adversary" } }),
    { subagent_type: "adversary" },
  );
  assert.deepEqual(resolveHookArgs({ args: { filePath: "x" } }, null), { filePath: "x" });
});

test("obsAppend: no-op without meta; dedupe plan-created; fail-open on throw", () => {
  assert.equal(resolveObsMetaPath({}), null);
  assert.equal(obsAppend({ type: "x" }, { env: {} }), false);
  const calls = [];
  assert.equal(
    obsAppend(
      { type: "pipeline-type", mode: "FULL" },
      {
        env: { HARNESS_OBSERVABILITY_RUN_PATH: "/tmp/obs-meta.json" },
        metaExists: () => true,
        appendEvent: (p, e) => calls.push({ p, e }),
      },
    ),
    true,
  );
  assert.equal(calls.length, 1);
  // dedupe
  assert.equal(
    obsAppend(
      { type: "plan-created" },
      {
        env: { HARNESS_OBSERVABILITY_RUN_PATH: "/tmp/obs-meta.json" },
        metaExists: () => true,
        readEvents: () => [{ type: "plan-created" }],
        dedupe: dedupeByType,
        appendEvent: (p, e) => calls.push({ p, e }),
      },
    ),
    false,
  );
  assert.equal(
    obsAppend(
      { type: "x" },
      {
        env: { HARNESS_OBSERVABILITY_RUN_PATH: "/tmp/x.json" },
        metaExists: () => true,
        appendEvent: () => {
          throw new Error("boom");
        },
      },
    ),
    false,
  );
  assert.equal(dedupeByType([{ type: "plan-created" }], { type: "plan-created" }), true);
  assert.equal(dedupeByType([], { type: "plan-created" }), false);
});
