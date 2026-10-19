/**
 * @description Hermetic e2e of a deliberate plan-scope correction after task admission (port of
 * Pi's "scope correction flows through planner review and the same task resume"): task-a stops for a
 * file outside its scope while task-b is integrated; the parent's planner dispatch is snapshotted
 * and must carry the recovery block, the planner appends the path to task-a only, a fresh
 * plan-reviewer APPROVE lets the SAME attempt resume with the corrected scope, task-a becomes ready
 * with the corrected contract hash and integrates, task-b's evidence stays valid, and delivery
 * opens. Only `claude` is fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { decide as gateDecide } from "./task-gate.mjs";
import { readIntegratedTaskEvidence } from "./lib/task-receipts.mjs";
import { ADMITTED_PLAN_FILE, PLAN_RECOVERY_MARKER } from "./lib/task-plan-recovery.mjs";
import { hashTaskReceipt } from "../../shared/lib/task-contract.mjs";
import { approvePlan, git, planTask } from "./lib/__fixtures__/task-fixture.mjs";
import { createVendoredTaskProject, laneSteps, tasksCli, waitSettled, writeFakeClaude } from "./lib/__fixtures__/task-e2e.mjs";

const FEATURE = "demo-feature";
const parentGate = (project, tool_name, tool_input, extra = {}) =>
  gateDecide({ session_id: project.sessionId, tool_name, tool_input, ...extra }, { env: {}, root: project.root });

test("e2e: an admitted task's scope is corrected through planner review and the same attempt resumes", { timeout: 900_000 }, async (t) => {
  const a = planTask("task-a", ["src/a"], { title: "Módulo A" });
  const b = planTask("task-b", ["src/b"], { title: "Módulo B" });
  const correctedA = { ...a, scope_paths: ["src/a", "src/a2"] };
  const project = createVendoredTaskProject(t, { tasks: [a, b] });
  // First launch: test-author, RED, fidelity, freeze and fidelity-pass, then the lane stops for scope.
  const full = laneSteps({ task: a });
  const firstA = full.slice(0, full.findIndex((step) => /fidelity-pass/.test(step.bash ?? "")) + 1);
  firstA.push({ text: "BLOCKED: src/a2/extra.mjs fica fora de scope_paths; a correção precisa desse arquivo." });
  const resumeA = laneSteps({ task: correctedA, skip: new Set(["author", "fidelity", "freeze", "fidelity-pass"]), productFiles: [
    { path: "src/a/index.mjs", content: "export { value } from \"../a2/extra.mjs\";\n" },
    { path: "src/a2/extra.mjs", content: "export const value = () => \"task-a-ok\";\n" },
  ] });
  const { bin, scenarioFile } = writeFakeClaude(project, { tasks: {
    "task-a": { launches: [{ steps: firstA }, { steps: resumeA }] },
    "task-b": { launches: [{ steps: laneSteps({ task: b }) }] },
  } });
  const cli = (action, params) => tasksCli(project, action, params, { claudeBin: bin });
  const byId = (status) => Object.fromEntries(status.tasks.map((task) => [task.task_id, task]));

  // 1. Both lanes run; a stops for scope, b is ready and integrates.
  assert.equal(cli("dispatch", { task_ids: ["task-a", "task-b"] }).ok, true);
  assert.equal(waitSettled(project, bin).ok, true);
  let status = byId(cli("status"));
  assert.equal(status["task-a"].status, "blocked");
  assert.equal(status["task-b"].status, "ready", status["task-b"].reason);
  const attemptA = status["task-a"].attempt_id;
  assert.equal(cli("integrate", { task_id: "task-b", attempt_id: status["task-b"].attempt_id, expected_head: status["task-b"].child_head }).ok, true);
  const registryFile = path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json");
  const admittedPlanSha = JSON.parse(fs.readFileSync(registryFile, "utf8")).plan_sha256;
  const grantBefore = fs.readFileSync(path.join(status["task-a"].worktree, ".claude/plans/.state/task-admission", `${attemptA}.json`));

  // 2. The planner dispatch is snapshotted and must carry the exact recovery block.
  const bare = parentGate(project, "Agent", { subagent_type: "planner", model: "opus", prompt: "add src/a2 to task-a" });
  assert.equal(bare.deny, true);
  const block = bare.reason.slice(bare.reason.indexOf(PLAN_RECOVERY_MARKER));
  assert.match(block, /never from session logs/);
  const snapshotted = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  assert.equal(snapshotted.plan_snapshot.written_by, "host-task-plan-snapshot");
  assert.equal(snapshotted.plan_snapshot.approval.verdict, "APPROVE");
  assert.ok(fs.existsSync(path.join(path.dirname(registryFile), ADMITTED_PLAN_FILE)), "the planner reads a paginable admitted copy");
  assert.equal(parentGate(project, "Agent", { subagent_type: "planner", model: "opus", prompt: `${block}\nAppend src/a2 to task-a scope_paths.` }).deny, false);
  assert.equal(parentGate(project, "Agent", { subagent_type: "executor", model: "haiku", prompt: "x" }).deny, true, "hands still run only in lanes");

  // 3. Only the planner subagent writes the plan; the spec stays frozen.
  const planPath = path.join(project.root, ".claude/plans", FEATURE, "execution-plan.json");
  const specPath = path.join(project.root, ".claude/plans", FEATURE, "spec.md");
  assert.equal(parentGate(project, "Write", { file_path: planPath, content: "{}" }).deny, true, "the main loop never edits the plan");
  assert.equal(parentGate(project, "Write", { file_path: planPath, content: "{}" }, { agent_id: "p1", agent_type: "planner" }).deny, false);
  assert.equal(parentGate(project, "Write", { file_path: specPath, content: "x" }, { agent_id: "p1", agent_type: "planner" }).deny, true);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.tasks = plan.tasks.map((task) => task.id === "task-a" ? { ...task, scope_paths: ["src/a", "src/a2"] } : task);
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);

  // 4. Without a fresh APPROVE nothing proceeds: the planner's write is not approval.
  assert.match(cli("resume", { task_id: "task-a", attempt_id: attemptA }).reason, /plan-reviewer APPROVE/);
  approvePlan(project.root, { sessionId: project.sessionId, toolUseId: "toolu_scope_correction" });
  const unaffected = readIntegratedTaskEvidence({ projectRoot: project.root, sessionId: project.sessionId, featureId: FEATURE, taskId: "task-b", headSha: git(project.root, "rev-parse", "HEAD") });
  assert.equal(unaffected.ok, true, `task-b keeps its evidence: ${unaffected.reason}`);

  // 5. The same attempt resumes with the corrected scope, becomes ready and integrates.
  const resumed = cli("resume", { task_id: "task-a", attempt_id: attemptA, instruction: "src/a2 entrou no escopo da task; implemente." });
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(waitSettled(project, bin).ok, true);
  status = byId(cli("status"));
  assert.equal(status["task-a"].status, "ready", `${status["task-a"].reason}`);
  assert.equal(status["task-a"].attempt_id, attemptA, "the same attempt");
  const second = JSON.parse(fs.readFileSync(`${scenarioFile}.task-a.argv.1.json`, "utf8"));
  assert.equal(second.resumed, true);
  assert.deepEqual(fs.readFileSync(path.join(status["task-a"].worktree, ".claude/plans/.state/task-admission", `${attemptA}.json`)), grantBefore, "the grant is immutable");
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  assert.equal(registry.plan_sha256, admittedPlanSha, "admission identity is kept");
  assert.equal(registry.tasks["task-a"].result.recovered_task_contract_sha256, hashTaskReceipt(correctedA));
  assert.equal(registry.tasks["task-b"].result.recovered_task_contract_sha256, undefined);
  const integrated = cli("integrate", { task_id: "task-a", attempt_id: attemptA, expected_head: status["task-a"].child_head });
  assert.equal(integrated.ok, true, integrated.reason);
  assert.ok(fs.existsSync(path.join(project.root, "src/a2/extra.mjs")));
  assert.equal(parentGate(project, "Bash", { command: "git push -u origin HEAD" }).deny, false, "delivery opens with every receipt valid");
});

test("e2e: a correction that rewrites an admitted contract or lacks the snapshot is refused", { timeout: 600_000 }, async (t) => {
  const a = planTask("task-a", ["src/a"], { title: "Módulo A" });
  const b = planTask("task-b", ["src/b"], { title: "Módulo B" });
  const project = createVendoredTaskProject(t, { tasks: [a, b] });
  const { bin } = writeFakeClaude(project, { tasks: {
    "task-a": { launches: [{ steps: [{ text: "BLOCKED" }] }] },
    "task-b": { launches: [{ steps: laneSteps({ task: b }) }] },
  } });
  const cli = (action, params) => tasksCli(project, action, params, { claudeBin: bin });
  assert.equal(cli("dispatch", { task_ids: ["task-a", "task-b"] }).ok, true);
  assert.equal(waitSettled(project, bin).ok, true);
  const status = Object.fromEntries(cli("status").tasks.map((task) => [task.task_id, task]));
  const planPath = path.join(project.root, ".claude/plans", FEATURE, "execution-plan.json");
  const original = fs.readFileSync(planPath, "utf8");
  const rewrite = (change, toolUseId) => {
    const plan = JSON.parse(original);
    change(plan);
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    approvePlan(project.root, { sessionId: project.sessionId, toolUseId });
    return cli("resume", { task_id: "task-a", attempt_id: status["task-a"].attempt_id });
  };
  // No planner dispatch happened, so no snapshot proves the admitted origin.
  assert.match(rewrite((plan) => { plan.tasks[0].scope_paths.push("src/a2"); }, "toolu_no_snapshot").reason, /original host-owned admission snapshot/);
  fs.writeFileSync(planPath, original);
  approvePlan(project.root, { sessionId: project.sessionId, toolUseId: "toolu_restore" });
  const block = parentGate(project, "Agent", { subagent_type: "planner", model: "opus", prompt: "x" }).reason;
  assert.match(block, /HARNESS_PLAN_RECOVERY/, "the snapshot is taken at the planner dispatch");
  for (const [label, change, pattern] of [
    ["unshift scope", (plan) => { plan.tasks[0].scope_paths.unshift("src/z"); }, /may only append scope_paths/],
    ["assertion change", (plan) => { plan.tasks[0].locked_tests[0].assertion = "Given x When y Then z"; }, /may only append locked_tests/],
    ["spec text", (plan) => { plan.tasks[0].spec = "something else"; }, /preserve task task-a behavior/],
    ["dependency", (plan) => { plan.tasks[0].depends_on = ["task-b"]; }, /preserve task task-a behavior|invalid corrected plan/],
    ["new task", (plan) => { plan.tasks.push(planTask("task-z", ["src/z"])); }, /preserve the approved feature contract and task set/],
  ]) {
    const refused = rewrite(change, `toolu_${label.replace(/\W/g, "_")}`);
    assert.equal(refused.ok, false, label);
    assert.match(refused.reason, pattern, label);
  }
  // A lane on the admitted plan keeps working when the parent only re-approves identical bytes.
  fs.writeFileSync(planPath, original);
  approvePlan(project.root, { sessionId: project.sessionId, toolUseId: "toolu_same_bytes" });
  const after = Object.fromEntries(cli("status").tasks.map((task) => [task.task_id, task]));
  assert.equal(after["task-b"].status, "ready", after["task-b"].reason);
});

test("e2e: correcting an integrated task's scope revokes its evidence until the same task is revalidated", { timeout: 900_000 }, async (t) => {
  const a = planTask("task-a", ["src/a"], { title: "Módulo A" });
  const b = planTask("task-b", ["src/b"], { title: "Módulo B" });
  const correctedB = { ...b, scope_paths: ["src/b", "src/b2"] };
  const project = createVendoredTaskProject(t, { tasks: [a, b] });
  const revalidateB = [
    { bash: `node .claude/hooks/mark.mjs active-scope --feature-id ${FEATURE} --task-id task-b --role sniper --scope-paths src/b,src/b2` },
    { agent: { subagent_type: "sniper", model: "haiku", prompt: "[HARNESS_TASK_CONTEXT]{\"task_id\":\"task-b\"}[/HARNESS_TASK_CONTEXT]\nAdd the helper.", writes: [{ path: "src/b2/helper.mjs", content: "export const helper = 1;\n" }], report: "## Status: DONE" } },
    { bash: "node --test test/task-b.test.mjs" },
    { bash: "git add src/b2/helper.mjs && git commit -qm 'fix(b): helper in the corrected scope'" },
    { bash: `node .claude/hooks/mark.mjs capture-verified --feature-id ${FEATURE} --task-id task-b` },
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: "[HARNESS_TASK_CONTEXT]{\"task_id\":\"task-b\"}[/HARNESS_TASK_CONTEXT]\nReview.", report: "## Veredito: pass" } },
    { text: "Revalidated." },
  ];
  const { bin } = writeFakeClaude(project, { tasks: {
    "task-a": { launches: [{ steps: laneSteps({ task: a }) }] },
    "task-b": { launches: [{ steps: laneSteps({ task: b }) }, { steps: revalidateB }] },
  } });
  const cli = (action, params) => tasksCli(project, action, params, { claudeBin: bin });
  const byId = () => Object.fromEntries(cli("status").tasks.map((task) => [task.task_id, task]));
  assert.equal(cli("dispatch", { task_ids: ["task-a", "task-b"] }).ok, true);
  assert.equal(waitSettled(project, bin).ok, true);
  for (const id of ["task-a", "task-b"]) {
    const task = byId()[id];
    assert.equal(cli("integrate", { task_id: id, attempt_id: task.attempt_id, expected_head: task.child_head }).ok, true, id);
  }
  assert.equal(parentGate(project, "Bash", { command: "git push" }).deny, false);

  const block = parentGate(project, "Agent", { subagent_type: "planner", model: "opus", prompt: "x" }).reason;
  assert.match(block, /HARNESS_PLAN_RECOVERY/);
  const planPath = path.join(project.root, ".claude/plans", FEATURE, "execution-plan.json");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  plan.tasks = plan.tasks.map((task) => task.id === "task-b" ? correctedB : task);
  fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  approvePlan(project.root, { sessionId: project.sessionId, toolUseId: "toolu_correct_b" });

  const head = () => git(project.root, "rev-parse", "HEAD");
  const evidence = (taskId) => readIntegratedTaskEvidence({ projectRoot: project.root, sessionId: project.sessionId, featureId: FEATURE, taskId, headSha: head() });
  assert.equal(evidence("task-a").ok, true, "the unaffected task keeps its evidence");
  assert.match(evidence("task-b").reason, /revalidation against its reviewed scope; resume the same task/);
  assert.match(parentGate(project, "Bash", { command: "git push" }).reason, /task-b/, "delivery waits for the affected task");

  const resumed = cli("resume", { task_id: "task-b", attempt_id: byId()["task-b"].attempt_id, instruction: "src/b2 entrou no escopo; adicione o helper." });
  assert.equal(resumed.ok, true, resumed.reason);
  assert.equal(waitSettled(project, bin).ok, true);
  const ready = byId()["task-b"];
  assert.equal(ready.status, "ready", ready.reason);
  assert.equal(cli("integrate", { task_id: "task-b", attempt_id: ready.attempt_id, expected_head: ready.child_head }).ok, true);
  assert.equal(evidence("task-b").ok, true, evidence("task-b").reason);
  assert.equal(parentGate(project, "Bash", { command: "git push" }).deny, false, "delivery reopens after revalidation");
});
