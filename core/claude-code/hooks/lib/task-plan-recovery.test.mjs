import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { approvalValid, preserveTaskPlanForPlanner, readTaskPlanAuthority, recoveredTaskContractHash, validateTaskScopeRecovery } from "./task-plan-recovery.mjs";
import { hashTaskReceipt } from "../../../shared/lib/task-contract.mjs";
import { createTaskProject, parallelPlan, planTask } from "./__fixtures__/task-fixture.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

function admitted(t) {
  const project = createTaskProject(t);
  const planPath = path.join(project.root, ".claude/plans", project.featureId, "execution-plan.json");
  const evidence = JSON.parse(fs.readFileSync(path.join(project.root, ".claude/plans/.state", project.sessionId, "plan-review-evidence.json"), "utf8"));
  const registryFile = path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json");
  fs.mkdirSync(path.dirname(registryFile), { recursive: true });
  const registry = { version: 1, parent_session_id: project.sessionId, feature_id: project.featureId, plan_sha256: evidence.plan_sha256, spec_sha256: evidence.spec_sha256,
    tasks: { "task-a": { task_id: "task-a", launches: [{ run_id: "r1" }] } } };
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  const identity = { projectRoot: project.root, sessionId: project.sessionId, featureId: project.featureId };
  return { project, planPath, evidence, registryFile, identity };
}

test("append-only validation: scope, allowed writes and locked tests may only grow at the end", () => {
  const before = parallelPlan([planTask("a", ["src/a"], { allowed_writes: ["docs/a.md"] }), planTask("b", ["src/b"])]);
  const grow = clone(before);
  grow.tasks[0].scope_paths.push("src/a2");
  grow.tasks[0].allowed_writes.push("docs/a2.md");
  grow.tasks[0].locked_tests.push({ test_path: "test/a2.test.mjs", assertion: "Given a2 When run Then ok" });
  assert.deepEqual(validateTaskScopeRecovery(before, grow), ["a"]);
  assert.deepEqual(validateTaskScopeRecovery(before, clone(before)), []);
  for (const [label, change, pattern] of [
    ["drop task", (p) => p.tasks.pop(), /task set/],
    ["empty scope", (p) => { p.tasks[0].scope_paths = []; }, /invalid corrected plan|may only append/],
    ["unshift scope", (p) => p.tasks[0].scope_paths.unshift("src/z"), /may only append scope_paths/],
    ["unshift allowed write", (p) => p.tasks[0].allowed_writes.unshift("docs/z.md"), /may only append allowed_writes/],
    ["rewrite locked test", (p) => { p.tasks[0].locked_tests[0].test_path = "test/other.test.mjs"; }, /may only append locked_tests/],
    ["severity", (p) => { p.tasks[0].severity = "high"; }, /preserve task a behavior/],
    ["feature", (p) => { p.feature_id = "other-feature"; }, /feature contract/],
    ["model strategy", (p) => { p.model_strategy.compliance = "opus"; }, /feature contract/],
  ]) {
    const after = clone(before);
    change(after);
    assert.throws(() => validateTaskScopeRecovery(before, after), pattern, label);
  }
});

test("the admitted snapshot is taken once, refused while a lane runs, and never replaced", (t) => {
  const { evidence, registryFile, identity, planPath } = admitted(t);
  assert.throws(() => preserveTaskPlanForPlanner(identity, { readProcess: () => ({ terminal: false }) }), /wait for active task processes/);
  assert.equal(JSON.parse(fs.readFileSync(registryFile, "utf8")).plan_snapshot, undefined);
  const first = preserveTaskPlanForPlanner(identity, { readProcess: () => ({ terminal: true }) });
  assert.equal(first.plan_sha256, evidence.plan_sha256);
  assert.deepEqual(JSON.parse(fs.readFileSync(first.path, "utf8")), JSON.parse(fs.readFileSync(planPath, "utf8")));
  const snapshot = JSON.parse(fs.readFileSync(registryFile, "utf8")).plan_snapshot;
  assert.ok(approvalValid(snapshot.approval, identity.sessionId, identity.featureId, evidence.plan_sha256, evidence.spec_sha256));
  fs.appendFileSync(planPath, "\n");
  preserveTaskPlanForPlanner(identity, { readProcess: () => ({ terminal: true }) });
  assert.deepEqual(JSON.parse(fs.readFileSync(registryFile, "utf8")).plan_snapshot, snapshot, "a second planner round keeps the baseline");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  registry.plan_snapshot.text += " ";
  fs.writeFileSync(registryFile, JSON.stringify(registry));
  assert.throws(() => preserveTaskPlanForPlanner(identity, { readProcess: () => ({ terminal: true }) }), /snapshot is invalid/);
});

test("authority: identical bytes keep the origin; changed bytes need a current APPROVE and the snapshot", (t) => {
  const { evidence, identity, planPath } = admitted(t);
  const args = { ...identity, planSha256: evidence.plan_sha256, specSha256: evidence.spec_sha256, originCallId: evidence.dispatch_call_id };
  const same = readTaskPlanAuthority(args);
  assert.deepEqual(same.affectedTasks, []);
  assert.equal(recoveredTaskContractHash(same, "task-a"), null);
  preserveTaskPlanForPlanner(identity, { readProcess: () => ({ terminal: true }) });
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.tasks[0].scope_paths.push("src/a2");
  fs.writeFileSync(planPath, JSON.stringify(plan));
  assert.throws(() => readTaskPlanAuthority(args), /current host-confirmed plan-reviewer APPROVE required/, "the planner's write is not approval");
  const evidenceFile = path.join(identity.projectRoot, ".claude/plans/.state", identity.sessionId, "plan-review-evidence.json");
  const digest = (file) => import("node:crypto").then(({ createHash }) => createHash("sha256").update(fs.readFileSync(file)).digest("hex"));
  return digest(planPath).then((planSha) => {
    fs.writeFileSync(evidenceFile, JSON.stringify({ ...evidence, dispatch_call_id: "toolu_new", plan_sha256: planSha }));
    const corrected = readTaskPlanAuthority(args);
    assert.deepEqual(corrected.affectedTasks, ["task-a"]);
    assert.equal(recoveredTaskContractHash(corrected, "task-a"), hashTaskReceipt(plan.tasks[0]));
    assert.equal(recoveredTaskContractHash(corrected, "task-b"), null);
    assert.throws(() => readTaskPlanAuthority({ ...args, originCallId: "toolu_foreign" }), /admission snapshot/, "a foreign origin is refused");
    fs.writeFileSync(evidenceFile, JSON.stringify({ ...evidence, dispatch_call_id: "toolu_new", plan_sha256: planSha, verdict: "REVISE" }));
    assert.throws(() => readTaskPlanAuthority(args), /APPROVE required/);
  });
});
