import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  admitTaskRun,
  inspectTaskAdmission,
  readTaskRunBinding,
  rollbackTaskAdmission,
  taskRunPrompt,
} from "./task-admission.mjs";
import { approvePlan, createTaskProject, git, reserveLane } from "./__fixtures__/task-fixture.mjs";

const LANE_SESSION = "33333333-3333-4333-8333-333333333333";

test("preflight is read-only and retryable; admission claims and seeds state without evidence", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const preflight = inspectTaskAdmission(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION });
  assert.equal(preflight.ok, true, preflight.reason);
  assert.equal(fs.existsSync(`${lane.grantPath}.claim`), false, "preflight writes no claim");
  assert.equal(inspectTaskAdmission(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION }).ok, true, "retry is allowed");

  const admitted = admitTaskRun(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION });
  assert.equal(admitted.ok, true, admitted.reason);
  const claim = JSON.parse(fs.readFileSync(`${lane.grantPath}.claim`, "utf8"));
  assert.deepEqual(claim, { session_id: LANE_SESSION, grant_sha256: admitted.grantSha });
  assert.equal(fs.statSync(`${lane.grantPath}.claim`).mode & 0o777, 0o600);
  const stateDir = path.join(lane.worktree, ".claude/plans/.state", LANE_SESSION);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "gate-state.json"), "utf8"));
  assert.deepEqual(Object.keys(state).sort(), ["classification_source", "feature_id", "session_id", "task_pipeline_version", "task_run"]);
  assert.equal(state.task_run.task_id, "task-a");
  for (const evidence of ["fidelity_pass", "capture_verified", "hand_finished", "regate_passed"]) {
    assert.equal(Object.hasOwn(state, evidence), false, `no fabricated ${evidence}`);
  }
  const triage = JSON.parse(fs.readFileSync(path.join(stateDir, "triage.json"), "utf8"));
  assert.equal(triage.mode, "FULL");
  assert.equal(admitTaskRun(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION }).ok, false, "a claimed attempt is never re-admitted");
  assert.equal(readTaskRunBinding(lane.worktree, LANE_SESSION).ok, true);
});

test("rollback removes only a pristine admission", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const admitted = admitTaskRun(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION });
  assert.equal(rollbackTaskAdmission(admitted), true);
  assert.equal(fs.existsSync(`${lane.grantPath}.claim`), false);
  assert.equal(fs.existsSync(path.join(lane.worktree, ".claude/plans/.state", LANE_SESSION)), false);

  const again = admitTaskRun(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION });
  assert.equal(again.ok, true, "retry after rollback");
  fs.writeFileSync(path.join(lane.worktree, ".claude/plans/.state", LANE_SESSION, "task-ledger.jsonl"), "{}\n");
  assert.equal(rollbackTaskAdmission(again), false, "a lane that already ran is never rolled back");
  assert.equal(fs.existsSync(`${lane.grantPath}.claim`), true);
});

test("binding fails closed when the grant, claim, lane triage, plan or parent approval change", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  assert.equal(admitTaskRun(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION }).ok, true);
  const mutate = (file, change) => {
    const before = fs.readFileSync(file);
    change();
    const result = readTaskRunBinding(lane.worktree, LANE_SESSION);
    fs.writeFileSync(file, before);
    return result;
  };
  const triage = path.join(lane.worktree, ".claude/plans/.state", LANE_SESSION, "triage.json");
  const parentPlan = path.join(project.root, ".claude/plans", project.featureId, "execution-plan.json");
  const parentSpec = path.join(project.root, ".claude/plans", project.featureId, "spec.md");
  const lanePlan = path.join(lane.worktree, ".claude/plans", project.featureId, "execution-plan.json");
  for (const [label, file, change, pattern] of [
    ["grant", lane.grantPath, () => fs.appendFileSync(lane.grantPath, " "), /grant changed/],
    ["claim", `${lane.grantPath}.claim`, () => fs.writeFileSync(`${lane.grantPath}.claim`, JSON.stringify({ session_id: "other", grant_sha256: "x" })), /claim mismatch/],
    ["triage", triage, () => fs.writeFileSync(triage, JSON.stringify({ session_id: LANE_SESSION, mode: "LIGHT", feature_id: project.featureId })), /triage changed/],
    ["parent plan", parentPlan, () => fs.appendFileSync(parentPlan, "\n"), /parent canonical plan\/spec changed/],
    ["parent spec", parentSpec, () => fs.appendFileSync(parentSpec, "x"), /parent canonical plan\/spec changed/],
    ["lane plan", lanePlan, () => fs.appendFileSync(lanePlan, "\n"), /plan\/spec hash mismatch/],
  ]) {
    const result = mutate(file, change);
    assert.equal(result.ok, false, label);
    assert.match(result.reason, pattern, label);
  }
  approvePlan(project.root, { toolUseId: "toolu_revise", verdict: "REVISE" });
  assert.match(readTaskRunBinding(lane.worktree, LANE_SESSION).reason, /plan-reviewer APPROVE/);
  approvePlan(project.root, { toolUseId: "toolu_reapprove" });
  assert.equal(readTaskRunBinding(lane.worktree, LANE_SESSION).ok, true, "re-approving identical bytes keeps the admission");
  git(lane.worktree, "switch", "-qc", "elsewhere");
  assert.match(readTaskRunBinding(lane.worktree, LANE_SESSION).reason, /exact task feature branch/);
});

test("admission refuses a dirty worktree, a moved HEAD, a non-parallel plan and a lane coordinator", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  fs.writeFileSync(path.join(lane.worktree, "stray.txt"), "x");
  assert.match(inspectTaskAdmission(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION }).reason, /dirty/);
  fs.rmSync(path.join(lane.worktree, "stray.txt"));
  fs.mkdirSync(path.join(lane.worktree, "node_modules"));
  fs.writeFileSync(path.join(lane.worktree, "node_modules", "x.js"), "");
  assert.equal(inspectTaskAdmission(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION }).ok, true, "copied deps are volatile");
  fs.writeFileSync(path.join(lane.worktree, "src", "x.txt"), "x");
  git(lane.worktree, "add", "-A");
  git(lane.worktree, "commit", "-qm", "moved");
  assert.match(inspectTaskAdmission(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION }).reason, /initial base mismatch/);
  assert.match(inspectTaskAdmission(lane.grantPath, { cwd: lane.worktree, sessionId: "../x" }).reason, /safe local session/);

  const serialProject = createTaskProject(t);
  const planFile = path.join(serialProject.root, ".claude/plans", serialProject.featureId, "execution-plan.json");
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  delete plan.execution;
  fs.writeFileSync(planFile, JSON.stringify(plan));
  approvePlan(serialProject.root, { toolUseId: "toolu_serial" });
  const serialLane = reserveLane(serialProject, "task-a");
  assert.match(inspectTaskAdmission(serialLane.grantPath, { cwd: serialLane.worktree, sessionId: LANE_SESSION }).reason, /opt into parallel/);
});

test("the lane prompt replaces the global runtime with the task runtime and an exact envelope", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const admitted = inspectTaskAdmission(lane.grantPath, { cwd: lane.worktree, sessionId: LANE_SESSION });
  const prompt = taskRunPrompt("TASK RUNTIME", admitted);
  assert.ok(prompt.startsWith("TASK RUNTIME\n\n[HARNESS_TASK_RUN]\n"));
  assert.doesNotMatch(prompt, /orchestrating-delivery \(you\)|triaging-requests/, "no global runtime text");
  const envelope = JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1));
  assert.equal(envelope.resumed, false);
  assert.equal(envelope.contract.task.id, "task-a");
  assert.equal(envelope.contract.mode, "FULL");
  assert.deepEqual(envelope.contract.frozen_paths, ["test/task-a.test.mjs"]);
  assert.equal(envelope.contract.plan_path, ".claude/plans/demo-feature/execution-plan.json");
  assert.deepEqual(envelope.contract.dispatch_routes.executor, { agent: "executor", model: "haiku", tier: "low" });
  assert.equal(JSON.parse(taskRunPrompt("R", admitted, { resumed: true }).match(/\{[\s\S]*\}/)[0]).resumed, true);
  assert.throws(() => taskRunPrompt("  ", admitted), /runtime prompt required/);
});
