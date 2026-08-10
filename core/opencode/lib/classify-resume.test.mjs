/** @description Locks idempotent response metadata after an approved plan has been adopted. */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resumedApprovedPlanMetadata } from "./classify-resume.mjs";

test("replaying classify after approved-plan adoption keeps the delivery route and canonical path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-classify-resume-"));
  const featureId = "resume-approved";
  const planSessionId = "ses-classify-source";
  const resumedStateId = "ses-classify-progress";
  const planPath = path.join(root, ".opencode", "plans", `${planSessionId}-${featureId}`, "execution-plan.json");
  try {
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, "{}\n");
    assert.deepEqual(resumedApprovedPlanMetadata(root, featureId, {
      resumed_from_session_id: planSessionId,
      resume_state_source_session_id: resumedStateId,
      planner_status: "usable",
      plan_review_verdict: "APPROVE",
      session_status: "completed",
      mode: "FULL",
    }), {
      plan_path: planPath,
      mode: "FULL",
      feature_id: featureId,
      action: "resume-approved-plan",
      source_session_id: resumedStateId,
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
