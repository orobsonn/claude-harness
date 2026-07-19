import test from "node:test";
import assert from "node:assert/strict";
import { sessionFeatureFromPlanPath } from "./plan-path-session.mjs";

test("absolute and relative plan paths", () => {
  const a = sessionFeatureFromPlanPath(
    "/root/wt/.opencode/plans/ses_084cde9adffeiFeFIgPIrw53iK-closed-to-arrival/execution-plan.json",
  );
  assert.equal(a.sessionId, "ses_084cde9adffeiFeFIgPIrw53iK");
  assert.equal(a.featureId, "closed-to-arrival");
  const b = sessionFeatureFromPlanPath(
    ".opencode/plans/ses_abc-feat-x/spec.md",
  );
  assert.equal(b.sessionId, "ses_abc");
  assert.equal(b.featureId, "feat-x");
});

test("non-plan paths null", () => {
  assert.equal(sessionFeatureFromPlanPath("src/foo.ts"), null);
  assert.equal(sessionFeatureFromPlanPath(""), null);
});
