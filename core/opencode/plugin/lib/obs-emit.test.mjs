/**
 * @description Tests for OC obs-emit pure decides + fail-open obsAppend.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("eventForPlanPath: execution-plan vs spec", () => {
  assert.deepEqual(eventForPlanPath(".opencode/plans/x/execution-plan.json"), {
    type: "plan-created",
  });
  assert.deepEqual(eventForPlanPath("/w/.opencode/plans/f/spec.md"), { type: "spec-created" });
  assert.equal(eventForPlanPath("README.md"), null);
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

test("obsAppend: no-op without meta; calls append when meta exists; fail-open on throw", () => {
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
  assert.equal(calls[0].e.type, "pipeline-type");
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
});
