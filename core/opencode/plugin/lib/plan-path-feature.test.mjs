import test from "node:test";
import assert from "node:assert/strict";
import { featureFromPlanPath } from "./plan-path-feature.mjs";

test("absolute and relative stable plan paths", () => {
  assert.deepEqual(
    featureFromPlanPath("/root/wt/.opencode/plans/closed-to-arrival/execution-plan.json"),
    { featureId: "closed-to-arrival" },
  );
  assert.deepEqual(featureFromPlanPath(".opencode/plans/feat-x/spec.md"), { featureId: "feat-x" });
});

test("session-scoped and non-plan paths are not accepted", () => {
  assert.equal(featureFromPlanPath(".opencode/plans/ses_abc-feat-x/execution-plan.json"), null);
  assert.equal(featureFromPlanPath("src/foo.ts"), null);
  assert.equal(featureFromPlanPath(""), null);
});
