/** @description Host dual-merge wiring (#384): both → artifact; secondary-only → pending no merge. */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  applyReviewOutcome,
  reserveReviewAttempt,
} from "./loop-decide.mjs";
import {
  buildDualMergeArtifact,
  dualMergeArtifactPath,
  dualMergeIntentFromOutcome,
  finalizeHostDualMerge,
  mergeHostDualEyes,
  driveDualEye,
  mergeDualVerdicts,
  writeDualMergeArtifact,
} from "./dual-merge.mjs";
import { createLoopGuardHooks } from "../loop-guard.ts";

const SESSION = "ses-dual-merge";
const FEATURE = "dual-merge-feat";
const GENERATION_1 = "11111111-1111-4111-8111-111111111111";

function report(verdict = "APPROVE", findings = []) {
  return JSON.stringify({ verdict, findings });
}

function family2Report(verdict = "APPROVE") {
  return JSON.stringify({ verdict, family: "family-2", findings: [] });
}

function input(overrides = {}) {
  return {
    subagentType: "plan-reviewer-family-1",
    sessionId: SESSION,
    featureId: FEATURE,
    callId: "call-1",
    taskId: "task-1",
    phase: "plan",
    response: report(),
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    session_id: SESSION,
    feature_id: FEATURE,
    ceremony_generation: GENERATION_1,
    planner_plan_binding: { snapshot_hash: "a".repeat(64) },
    ...overrides,
  };
}

function complete(previous, values = {}) {
  const args = input(values);
  const reserved = reserveReviewAttempt(previous, args);
  assert.equal(reserved.ok, true, reserved.reason);
  return applyReviewOutcome(reserved.state, args);
}

test("#ac-1.1 primary+secondary useful same scope → dual both + merge artifact + plan_verdict", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-merge-both-"));
  try {
    const primary = complete(state(), {
      callId: "p1",
      response: report("APPROVE"),
    });
    assert.equal(primary.state.dual_status?.plan_review, "primary_only");
    assert.equal(primary.state.plan_verdict, "APPROVE");
    assert.ok(primary.state.primary_review_last_report);

    const secondary = complete(primary.state, {
      subagentType: "plan-reviewer-family-2",
      callId: "s1",
      response: family2Report("APPROVE"),
    });
    assert.equal(secondary.accepted, true);
    assert.equal(secondary.dualBecameBoth, true);
    assert.equal(secondary.state.dual_status?.plan_review, "both");
    assert.equal(secondary.state.plan_verdict, "APPROVE");
    assert.ok(secondary.state.secondary_review_last_report);

    const intent = dualMergeIntentFromOutcome(secondary);
    assert.ok(intent, "dualMergeIntentFromOutcome must surface both");
    assert.equal(intent.dual_status, "both");
    assert.equal(intent.phase, "plan_review");

    const finalized = finalizeHostDualMerge({
      projectRoot: root,
      sessionId: SESSION,
      ...intent,
    });
    assert.equal(finalized.ok, true, finalized.reason);
    assert.equal(finalized.written, true);
    assert.ok(finalized.path);
    assert.equal(fs.existsSync(finalized.path), true);
    const artifact = JSON.parse(fs.readFileSync(finalized.path, "utf8"));
    assert.equal(artifact.dual_status, "both");
    assert.equal(artifact.phase, "plan_review");
    assert.equal(artifact.verdict, "APPROVE");
    assert.equal(artifact.scope_hash, intent.scope_hash);
    assert.equal(artifact.primary_report_hash, intent.primary_report_hash);
    assert.equal(artifact.secondary_report_hash, intent.secondary_report_hash);
    assert.ok(typeof artifact.merged_at === "string" && artifact.merged_at.length > 0);

    // either-REVISE-wins still authority when secondary revises
    const revised = complete(state(), {
      callId: "p-rev",
      response: report("REVISE", [{
        area: "introduced-risk",
        severity: "high",
        task_id: "task-1",
        problem: "race",
        planner_instruction: "serialize",
      }]),
    });
    const bothRevise = complete(revised.state, {
      subagentType: "plan-reviewer-family-2",
      callId: "s-rev",
      response: family2Report("APPROVE"),
    });
    assert.equal(bothRevise.state.dual_status?.plan_review, "both");
    assert.equal(bothRevise.state.plan_verdict, "REVISE");
    const intent2 = dualMergeIntentFromOutcome(bothRevise);
    const fin2 = finalizeHostDualMerge({ projectRoot: root, sessionId: SESSION, ...intent2 });
    assert.equal(fin2.ok, true, fin2.reason);
    assert.equal(fin2.artifact?.verdict, "REVISE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#ac-1.3 secondary useful primary missing → dual pending not both; no merge-as-both", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-merge-pending-"));
  try {
    const secondaryOnly = complete(state(), {
      subagentType: "plan-reviewer-family-2",
      callId: "sec-first",
      response: family2Report("APPROVE"),
    });
    assert.equal(secondaryOnly.accepted, true);
    assert.equal(secondaryOnly.dualBecameBoth, false);
    assert.equal(secondaryOnly.state.dual_status?.plan_review, "pending");
    assert.notEqual(secondaryOnly.state.dual_status?.plan_review, "both");
    assert.equal(dualMergeIntentFromOutcome(secondaryOnly), null);

    const fin = finalizeHostDualMerge({
      projectRoot: root,
      sessionId: SESSION,
      phase: "plan_review",
      scope_hash: secondaryOnly.scopeHash || "deadbeef",
      primary_report_hash: "",
      secondary_report_hash: secondaryOnly.state.secondary_review_last_report_hash,
      primaryReport: null,
      secondaryReport: secondaryOnly.state.secondary_review_last_report,
      dual_status: "pending",
    });
    assert.equal(fin.written, false);
    const mergeDir = path.join(root, ".opencode", "plans", ".state", SESSION, "dual-merge");
    assert.equal(fs.existsSync(mergeDir), false);

    // writeDualMergeArtifact refuses non-both
    const refuse = writeDualMergeArtifact(root, SESSION, {
      phase: "plan_review",
      scope_hash: "abc",
      dual_status: "pending",
      primary_report_hash: "x",
      secondary_report_hash: "y",
      merged_at: new Date().toISOString(),
    });
    assert.equal(refuse.ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#ac-1.2 host dual-merge module imports/calls driveDualEye + mergeDualVerdicts", () => {
  assert.equal(typeof driveDualEye, "function");
  assert.equal(typeof mergeDualVerdicts, "function");
  assert.equal(typeof mergeHostDualEyes, "function");

  const require = createRequire(import.meta.url);
  const dualMergeSrc = fs.readFileSync(require.resolve("./dual-merge.mjs"), "utf8");
  assert.match(dualMergeSrc, /driveDualEye/);
  assert.match(dualMergeSrc, /dual-runtime\.mjs/);
  const loopGuardSrc = fs.readFileSync(
    path.join(path.dirname(require.resolve("./dual-merge.mjs")), "..", "loop-guard.ts"),
    "utf8",
  );
  assert.match(loopGuardSrc, /dual-merge\.mjs/);
  assert.match(loopGuardSrc, /finalizeHostDualMerge/);

  const reviseFinding = {
    area: "scope",
    severity: "medium",
    task_id: "task-1",
    problem: "scope too wide",
    planner_instruction: "narrow scope_paths",
  };
  const merged = mergeHostDualEyes({
    phase: "plan_review",
    primaryReport: { verdict: "APPROVE", findings: [] },
    secondaryReport: { verdict: "REVISE", family: "family-2", findings: [reviseFinding] },
  });
  assert.equal(merged.ok, true, merged.reason);
  assert.equal(merged.dual_status, "both");
  assert.equal(merged.verdict, "REVISE");
});

test("loop-guard host path writes merge artifact after dual both", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-merge-hook-"));
  try {
    const file = path.join(root, ".opencode", "plans", ".state", SESSION, "gate-state.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state()));
    const hooks = await createLoopGuardHooks(root);

    const primaryIn = { tool: "task", sessionID: SESSION, callID: "hook-p1" };
    const primaryOut = {
      args: {
        subagent_type: "plan-reviewer-family-1",
        feature_id: FEATURE,
        task_id: "task-1",
        phase: "plan",
      },
      output: report("APPROVE"),
    };
    await hooks["tool.execute.before"](primaryIn, primaryOut);
    await hooks["tool.execute.after"](primaryIn, primaryOut);

    const secondaryIn = { tool: "task", sessionID: SESSION, callID: "hook-s1" };
    const secondaryOut = {
      args: {
        subagent_type: "plan-reviewer-family-2",
        feature_id: FEATURE,
        task_id: "task-1",
        phase: "plan",
      },
      output: family2Report("APPROVE"),
    };
    await hooks["tool.execute.before"](secondaryIn, secondaryOut);
    await hooks["tool.execute.after"](secondaryIn, secondaryOut);

    const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(persisted.dual_status?.plan_review, "both");
    assert.equal(persisted.plan_verdict, "APPROVE");

    const mergeDir = path.join(root, ".opencode", "plans", ".state", SESSION, "dual-merge");
    assert.equal(fs.existsSync(mergeDir), true, "dual-merge dir must exist after host finalize");
    const files = fs.readdirSync(mergeDir).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^plan_review-[a-f0-9]+\.json$/);
    const artifact = JSON.parse(fs.readFileSync(path.join(mergeDir, files[0]), "utf8"));
    assert.equal(artifact.dual_status, "both");
    assert.equal(artifact.verdict, "APPROVE");
    assert.equal(artifact.phase, "plan_review");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("buildDualMergeArtifact + path helpers are deterministic under gate-state dir", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dual-merge-path-"));
  try {
    const scope = "b".repeat(64);
    const built = buildDualMergeArtifact({
      phase: "plan_review",
      scope_hash: scope,
      primary_report_hash: "c".repeat(64),
      secondary_report_hash: "d".repeat(64),
      primaryReport: { verdict: "APPROVE", findings: [] },
      secondaryReport: { verdict: "APPROVE", family: "family-2", findings: [] },
    });
    assert.equal(built.ok, true, built.reason);
    const target = dualMergeArtifactPath(root, SESSION, "plan_review", scope);
    assert.equal(target.ok, true);
    assert.equal(
      target.path,
      path.join(root, ".opencode", "plans", ".state", SESSION, "dual-merge", `plan_review-${scope}.json`),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
