/** @description Locks feature-scoped resume discovery and session-state adoption. */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adoptFeatureResume, findFeatureResume } from "./feature-resume.mjs";
import { resolvePlannerArtifactPath } from "./planner-artifact.mjs";
import { semanticPlanHash } from "./plan-hash.mjs";

const featureId = "resume-feature";
const sourceSession = "ses-resume-source";
const targetSession = "ses-resume-target";
const modelStrategy = {
  hand_tiers: { low: "gemma4", medium: "glm-5.2", high: "kimi-k2.7-code" },
  planner: "openai/planner",
  "plan-reviewer": "openai/reviewer",
  compliance: "openai/compliance",
  adversary: "openai/adversary",
  security: "openai/security",
  shipper: "openai/shipper",
  harvester: "openai/harvester",
};

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

function fullPlan(featureId, revision = "a") {
  return {
    feature_id: featureId,
    kind: "full",
    mode: "full",
    model_strategy: modelStrategy,
    tasks: [{
      id: "task-one",
      severity: "low",
      complexity: "low",
      scope_paths: [`src/${revision}.mjs`],
      criterion_refs: ["#ac-1"],
      depends_on: [],
      locked_tests: [],
      no_tests: true,
    }, {
      id: "task-two",
      severity: "low",
      complexity: "low",
      scope_paths: [`src/${revision}.mjs`],
      criterion_refs: ["#ac-2"],
      depends_on: [],
      locked_tests: [],
      no_tests: true,
    }],
  };
}

function writeApprovedRun(root, { sessionId, planSessionId = sessionId, featureId, plan, captured = [], completed = false, finalReview = completed, statePatch = {} }) {
  const planDir = path.join(root, ".opencode", "plans", `${planSessionId}-${featureId}`);
  const stateDir = path.join(root, ".opencode", "plans", ".state", sessionId);
  const bytes = Buffer.from(JSON.stringify(plan));
  const fileHash = crypto.createHash("sha256").update(bytes).digest("hex");
  const snapshotPath = path.join(stateDir, "bound-plans", `${fileHash}.json`);
  fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
  fs.mkdirSync(planDir, { recursive: true });
  fs.writeFileSync(snapshotPath, bytes);
  fs.writeFileSync(path.join(planDir, "execution-plan.json"), bytes);
  fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
    session_id: sessionId,
    feature_id: featureId,
    mode: "FULL",
    planner_status: "usable",
    plan_review_verdict: "APPROVE",
    session_status: completed ? "completed" : "active",
    ...(finalReview ? { final_review_done: true } : {}),
    ...(sessionId === planSessionId ? {} : { resumed_from_session_id: planSessionId }),
    planner_plan_binding: {
      session_id: sessionId,
      feature_id: featureId,
      snapshot_path: path.relative(root, snapshotPath),
      snapshot_hash: semanticPlanHash(plan),
      snapshot_file_hash: fileHash,
      semantic_hash: semanticPlanHash(plan),
      file_hash: fileHash,
      expected_model_strategy: modelStrategy,
    },
    capture_verified: captured,
    ...statePatch,
  }));
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

test("keeps the bound plan ceremony when a later request is classified more conservatively", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-bound-mode-"));
  try {
    const plan = fullPlan(featureId);
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan,
      statePatch: { mode: "LIGHT" },
    });
    const adopted = adoptFeatureResume(root, targetSession, findFeatureResume(root, featureId), "FULL");
    assert.equal(adopted.ok, true);
    const state = JSON.parse(fs.readFileSync(adopted.statePath, "utf8"));
    assert.equal(state.mode, "LIGHT");
    assert.equal(state.peak_mode, "LIGHT");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

test("adopts verified progress from a later resumed session while keeping the canonical plan session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-progress-"));
  const resumedSession = "ses-resume-progress";
  try {
    const plan = fullPlan(featureId);
    writeApprovedRun(root, { sessionId: sourceSession, featureId, plan });
    writeApprovedRun(root, {
      sessionId: resumedSession,
      planSessionId: sourceSession,
      featureId,
      plan,
      captured: [`${featureId}/task-one@freeze`],
    });

    const resume = findFeatureResume(root, featureId);
    assert.equal(resume?.sessionId, resumedSession);
    assert.equal(resume?.planSessionId, sourceSession);

    const adopted = adoptFeatureResume(root, targetSession, resume);
    assert.equal(adopted.ok, true);
    const state = JSON.parse(fs.readFileSync(adopted.statePath, "utf8"));
    assert.deepEqual(state.capture_verified, [`${featureId}/task-one@freeze`]);
    assert.equal(state.resumed_from_session_id, sourceSession);
    assert.equal(state.resume_state_source_session_id, resumedSession);
    assert.equal(adoptFeatureResume(root, targetSession, resume).ok, true, "same resume adoption is idempotent");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when separate approved plan revisions are both resumable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-revision-"));
  const revisionSession = "ses-resume-revision";
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId, "a"),
      captured: [`${featureId}/task-one@freeze`],
    });
    writeApprovedRun(root, {
      sessionId: revisionSession,
      featureId,
      plan: fullPlan(featureId, "b"),
    });

    assert.equal(findFeatureResume(root, featureId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prefers an intact unreviewed bound plan over a newer classify stub", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-unreviewed-"));
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      statePatch: { plan_review_verdict: null },
    });
    const stubPlanPath = path.join(root, ".opencode", "plans", `${targetSession}-${featureId}`, "execution-plan.json");
    const stubStatePath = path.join(root, ".opencode", "plans", ".state", targetSession, "gate-state.json");
    fs.mkdirSync(path.dirname(stubPlanPath), { recursive: true });
    fs.mkdirSync(path.dirname(stubStatePath), { recursive: true });
    fs.writeFileSync(stubPlanPath, JSON.stringify({ kind: "stub", mode: "FULL", feature_id: featureId, tasks: [] }));
    fs.writeFileSync(stubStatePath, JSON.stringify({
      session_id: targetSession,
      feature_id: featureId,
      mode: "FULL",
      planner_status: "not_started",
      planner_active_attempt: null,
    }));

    const resume = findFeatureResume(root, featureId);
    assert.equal(resume?.sessionId, sourceSession);
    assert.equal(resume?.plan.kind, "full");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrates captured legacy progress to an approved resumed plan without another review", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-legacy-approved-"));
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      captured: [`${featureId}/task-one@freeze`],
      statePatch: { plan_review_verdict: null },
    });

    const resume = findFeatureResume(root, featureId);
    assert.equal(resume?.approved, true, "captured legacy progress proves this plan had already entered delivery");
    assert.equal(resume?.legacyApproved, true);

    const adopted = adoptFeatureResume(root, targetSession, resume);
    assert.equal(adopted.ok, true);
    const state = JSON.parse(fs.readFileSync(adopted.statePath, "utf8"));
    assert.equal(state.plan_review_verdict, "APPROVE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps an unreviewed legacy plan without captured progress awaiting review", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-legacy-unreviewed-"));
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      statePatch: { plan_review_verdict: null },
    });

    const resume = findFeatureResume(root, featureId);
    assert.equal(resume?.approved, false);
    assert.equal(resume?.legacyApproved, false);

    const adopted = adoptFeatureResume(root, targetSession, resume);
    assert.equal(adopted.ok, true);
    const state = JSON.parse(fs.readFileSync(adopted.statePath, "utf8"));
    assert.equal(state.plan_review_verdict, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("repairs captured legacy approval when classify replays in the same resumed session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-legacy-replay-"));
  const resumedSession = "ses-resume-legacy-replay";
  try {
    writeApprovedRun(root, {
      sessionId: resumedSession,
      planSessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      captured: [`${featureId}/task-one@freeze`],
      statePatch: {
        plan_review_verdict: null,
        resume_state_source_session_id: "ses-original-progress",
      },
    });

    const resume = findFeatureResume(root, featureId);
    assert.equal(resume?.sessionId, resumedSession);
    assert.equal(resume?.legacyApproved, true);

    const promoted = adoptFeatureResume(root, resumedSession, resume);
    assert.equal(promoted.ok, true);
    const state = JSON.parse(fs.readFileSync(promoted.statePath, "utf8"));
    assert.equal(state.plan_review_verdict, "APPROVE");
    assert.equal(state.resume_state_source_session_id, "ses-original-progress");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when unreviewed bound plan identities diverge", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-unreviewed-divergent-"));
  const revisionSession = "ses-resume-unreviewed-revision";
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId, "a"),
      statePatch: { plan_review_verdict: null },
    });
    writeApprovedRun(root, {
      sessionId: revisionSession,
      featureId,
      plan: fullPlan(featureId, "b"),
      statePatch: { plan_review_verdict: null },
    });
    assert.equal(findFeatureResume(root, featureId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not let a bound REVISE mask a missing review verdict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-review-state-"));
  const reviewSession = "ses-resume-reviewed";
  try {
    const plan = fullPlan(featureId);
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan,
      statePatch: { plan_review_verdict: null },
    });
    writeApprovedRun(root, {
      sessionId: reviewSession,
      planSessionId: sourceSession,
      featureId,
      plan,
      statePatch: { plan_review_verdict: "REVISE" },
    });
    assert.equal(findFeatureResume(root, featureId)?.sessionId, sourceSession);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prefers a bound REVISE over a newer classify stub when review-missing is absent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-revise-"));
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      statePatch: { plan_review_verdict: "REVISE" },
    });
    const stubPlanPath = path.join(root, ".opencode", "plans", `${targetSession}-${featureId}`, "execution-plan.json");
    const stubStatePath = path.join(root, ".opencode", "plans", ".state", targetSession, "gate-state.json");
    fs.mkdirSync(path.dirname(stubPlanPath), { recursive: true });
    fs.mkdirSync(path.dirname(stubStatePath), { recursive: true });
    fs.writeFileSync(stubPlanPath, JSON.stringify({ kind: "stub", mode: "FULL", feature_id: featureId, tasks: [] }));
    fs.writeFileSync(stubStatePath, JSON.stringify({
      session_id: targetSession,
      feature_id: featureId,
      mode: "FULL",
      planner_status: "not_started",
      planner_active_attempt: null,
    }));
    assert.equal(findFeatureResume(root, featureId)?.sessionId, sourceSession);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses incomparable verified progress from the same plan lineage", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-incomparable-"));
  const resumedSession = "ses-resume-incomparable";
  try {
    const plan = fullPlan(featureId);
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan,
      captured: [`${featureId}/task-one@freeze`],
    });
    writeApprovedRun(root, {
      sessionId: resumedSession,
      planSessionId: sourceSession,
      featureId,
      plan,
      captured: [`${featureId}/task-two@freeze`],
    });
    assert.equal(findFeatureResume(root, featureId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not infer an authoritative revision from a resumed session's own plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-own-plan-"));
  const revisedSession = "ses-resume-own-plan";
  try {
    writeApprovedRun(root, { sessionId: sourceSession, featureId, plan: fullPlan(featureId, "a") });
    writeApprovedRun(root, { sessionId: revisedSession, featureId, plan: fullPlan(featureId, "b") });
    const statePath = path.join(root, ".opencode", "plans", ".state", revisedSession, "gate-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.resumed_from_session_id = sourceSession;
    fs.writeFileSync(statePath, JSON.stringify(state));

    assert.equal(findFeatureResume(root, featureId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("keeps a delivery-complete session eligible until final review is finished", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-complete-"));
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      captured: [`${featureId}/task-one@freeze`],
      completed: true,
      finalReview: false,
    });
    assert.equal(findFeatureResume(root, featureId)?.sessionId, sourceSession);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("does not reopen a final-reviewed session", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-final-review-"));
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      captured: [`${featureId}/task-one@freeze`, `${featureId}/task-two@freeze`],
      completed: true,
      finalReview: true,
    });
    assert.equal(findFeatureResume(root, featureId), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("ignores a running stub instead of adopting an active planner lease", () => {
  const f = fixture();
  try {
    const statePath = path.join(f.root, ".opencode", "plans", ".state", sourceSession, "gate-state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.planner_status = "running";
    state.planner_active_attempt = { call_id: "call-live" };
    fs.writeFileSync(statePath, JSON.stringify(state));
    assert.equal(findFeatureResume(f.root, featureId), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("skips a corrupt candidate without hiding a valid prior run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-corrupt-"));
  const corruptSession = "ses-resume-corrupt";
  try {
    const plan = fullPlan(featureId);
    writeApprovedRun(root, { sessionId: sourceSession, featureId, plan });
    const stateDir = path.join(root, ".opencode", "plans", ".state", corruptSession);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
      session_id: corruptSession,
      feature_id: featureId,
      mode: "FULL",
      planner_status: "usable",
      plan_review_verdict: "APPROVE",
      resumed_from_session_id: sourceSession,
      planner_plan_binding: {
        session_id: corruptSession,
        feature_id: featureId,
        snapshot_path: `.opencode/plans/.state/${corruptSession}/bound-plans/${"a".repeat(64)}.json`,
        snapshot_hash: semanticPlanHash(plan),
        snapshot_file_hash: "a".repeat(64),
        semantic_hash: semanticPlanHash(plan),
        file_hash: "a".repeat(64),
        expected_model_strategy: modelStrategy,
      },
    }));
    assert.equal(findFeatureResume(root, featureId)?.sessionId, sourceSession);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("retains only capture-verified facts when a resumed task stopped before capture", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-feature-resume-partial-hand-"));
  try {
    writeApprovedRun(root, {
      sessionId: sourceSession,
      featureId,
      plan: fullPlan(featureId),
      captured: [`${featureId}/task-one@freeze`],
      statePatch: {
        fidelity_pass: [`${featureId}/task-two@freeze`],
        hand_finished: [`${featureId}/task-two`],
        regate_pending: [`${featureId}/task-two`],
        regate_passed: [`${featureId}/task-two@freeze`],
      },
    });
    const adopted = adoptFeatureResume(root, targetSession, findFeatureResume(root, featureId));
    assert.equal(adopted.ok, true);
    const state = JSON.parse(fs.readFileSync(adopted.statePath, "utf8"));
    assert.deepEqual(state.capture_verified, [`${featureId}/task-one@freeze`]);
    assert.deepEqual(state.fidelity_pass, []);
    assert.deepEqual(state.hand_finished, []);
    assert.deepEqual(state.regate_pending, []);
    assert.deepEqual(state.regate_passed, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
