/** @description Locks feature-scoped resume discovery and session-state adoption. */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptFeatureResume, findFeatureResume } from "./feature-resume.mjs";
import { resolvePlannerArtifactPath } from "./planner-artifact.mjs";

const featureId = "resume-feature";
const sourceSession = "ses-resume-source";
const targetSession = "ses-resume-target";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-"));
  const planPath = path.join(root, ".opencode", "plans", `${sourceSession}-${featureId}`, "execution-plan.json");
  const statePath = path.join(root, ".opencode", "plans", ".state", sourceSession, "gate-state.json");
  const plan = { feature_id: featureId, kind: "stub", tasks: [] };
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(planPath, JSON.stringify(plan));
  fs.writeFileSync(statePath, JSON.stringify({
    session_id: sourceSession,
    feature_id: featureId,
    mode: "FULL",
    planner_status: "not_started",
    plan_review_verdict: "REVISE",
  }));
  return { root, planPath };
}

test("discovers and adopts a prior feature without copying its plan", () => {
  const f = fixture();
  try {
    const resume = findFeatureResume(f.root, featureId);
    assert.equal(resume?.sessionId, sourceSession);
    assert.equal(resolvePlannerArtifactPath(f.root, targetSession, featureId), f.planPath);

    const adopted = adoptFeatureResume(f.root, targetSession, resume);
    assert.equal(adopted.ok, true);
    assert.equal(fs.existsSync(path.join(f.root, ".opencode", "plans", `${targetSession}-${featureId}`, "execution-plan.json")), false);
    const state = JSON.parse(fs.readFileSync(adopted.statePath, "utf8"));
    assert.equal(state.session_id, targetSession);
    assert.equal(state.plan_review_verdict, "REVISE");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("ignores paths whose feature or session state identity does not match", () => {
  const f = fixture();
  try {
    const statePath = path.join(f.root, ".opencode", "plans", ".state", sourceSession, "gate-state.json");
    fs.writeFileSync(statePath, JSON.stringify({ session_id: sourceSession, feature_id: "other-feature" }));
    assert.equal(findFeatureResume(f.root, featureId), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
