/**
 * @description Full hermetic e2e of parallel task lanes (prompt §4): a consumer with the vendored
 * harness, three tasks (a, b independent; c depends on a), parallel dispatch, host wait, ready via
 * inspection, exact integration, a dependent dispatch, a correction of an integrated task that opens
 * the barrier and brings c to host reconciliation, reintegration, and the delivery gate opening only
 * when every receipt is valid at the final HEAD. Only `claude` is fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { decide as gateDecide } from "./task-gate.mjs";
import { readAllIntegratedTaskEvidence, readIntegratedTaskEvidence } from "./lib/task-receipts.mjs";
import { hashTaskReceipt } from "../../shared/lib/task-contract.mjs";
import { defaultTasks, git } from "./lib/__fixtures__/task-fixture.mjs";
import { createVendoredTaskProject, laneSteps, marker, tasksCli, tasksCliChild, waitSettled, writeFakeClaude } from "./lib/__fixtures__/task-e2e.mjs";

const FEATURE = "demo-feature";
const mark = (taskId, action, extra = "") => ({ bash: `node .claude/hooks/mark.mjs ${action} --feature-id ${FEATURE} --task-id ${taskId}${extra}` });
const pushAllowed = (project) => !gateDecide({ session_id: project.sessionId, tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" } }, { env: {}, root: project.root }).deny;

test("e2e: parallel lanes, integration, dependent, correction barrier, reconciliation and the delivery gate", { timeout: 900_000 }, async (t) => {
  const tasks = defaultTasks();
  const [a, b, c] = tasks;
  const project = createVendoredTaskProject(t, { tasks });
  const correctionOfA = [
    mark("task-a", "active-scope", " --role sniper --scope-paths src/a"),
    { agent: { subagent_type: "sniper", model: "haiku", prompt: `${marker("task-a")}\nApply the reviewer finding.`, writes: [{ path: "src/a/index.mjs", content: "export const value = () => \"task-a-ok\"; // corrected\n" }], report: "## Status: DONE" } },
    { bash: "node --test test/task-a.test.mjs" },
    { bash: "git add src/a/index.mjs && git commit -qm 'fix(a): reviewer finding'" },
    mark("task-a", "capture-verified"),
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-a")}\nReview the correction.`, report: "## Veredito: pass" } },
    { text: "Correction ready." },
  ];
  const reconciliationOfC = [
    mark("task-c", "capture-verified"),
    { agent: { subagent_type: "compliance", model: "sonnet", prompt: `${marker("task-c")}\nReview the reconciled HEAD.`, report: "## Veredito: pass" } },
    { text: "Reconciled." },
  ];
  const { bin, scenarioFile } = writeFakeClaude(project, { tasks: {
    "task-a": { launches: [{ steps: laneSteps({ task: a }) }, { steps: correctionOfA }] },
    "task-b": { launches: [{ steps: laneSteps({ task: b }) }] },
    "task-c": { launches: [{ steps: laneSteps({ task: c }) }, { steps: reconciliationOfC }] },
  } });
  const cli = (action, params) => tasksCli(project, action, params, { claudeBin: bin });

  // 1-2. Plan with three tasks; dispatch the two independent ones in parallel.
  const dispatched = cli("dispatch", { task_ids: ["task-a", "task-b"], task_contexts: [{ task_id: "task-a", content: "Keep the public API tiny." }] });
  assert.equal(dispatched.ok, true, dispatched.reason);
  assert.deepEqual(dispatched.tasks.map((task) => task.status), ["running", "running"]);
  assert.match(cli("dispatch", { task_ids: ["task-c"] }).reason, /dependency task-a must be integrated/);
  // 3-4. Wait on the host; both become ready by inspection.
  const settled = waitSettled(project, bin);
  assert.equal(settled.ok, true, settled.reason);
  let status = cli("status");
  const byId = () => Object.fromEntries(status.tasks.map((task) => [task.task_id, task]));
  assert.deepEqual(status.tasks.map((task) => `${task.task_id}:${task.status}`).sort(), ["task-a:ready", "task-b:ready"], JSON.stringify(status.diagnostics));
  const firstA = JSON.parse(fs.readFileSync(`${scenarioFile}.task-a.argv.0.json`, "utf8"));
  assert.equal(firstA.resumed, false);
  assert.equal(firstA.cwd, byId()["task-a"].worktree);
  assert.equal(pushAllowed(project), false, "delivery waits for every task");

  // 5. Integrate a.
  const integratedA = cli("integrate", { task_id: "task-a", attempt_id: byId()["task-a"].attempt_id, expected_head: byId()["task-a"].child_head });
  assert.equal(integratedA.ok, true, integratedA.reason);
  assert.equal(git(project.root, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").length, 3, "a two-parent merge");

  // 6. Dispatch c on top of the aggregate that contains a.
  assert.equal(cli("dispatch", { task_ids: ["task-c"] }).ok, true);
  assert.equal(waitSettled(project, bin).ok, true);
  status = cli("status");
  assert.equal(byId()["task-c"].status, "ready", byId()["task-c"].reason);

  // 7. Integrate b and c; the delivery gate opens.
  for (const id of ["task-b", "task-c"]) {
    const result = cli("integrate", { task_id: id, attempt_id: byId()[id].attempt_id, expected_head: byId()[id].child_head });
    assert.equal(result.ok, true, `${id}: ${result.reason}`);
    status = cli("status");
  }
  assert.equal(pushAllowed(project), true);

  // 8. Correct a after integration: the barrier closes delivery and new work.
  const resumedA = cli("resume", { task_id: "task-a", attempt_id: byId()["task-a"].attempt_id, instruction: "Apply the reviewer finding on A." });
  assert.equal(resumedA.ok, true, resumedA.reason);
  assert.equal(pushAllowed(project), false, "the correction barrier blocks delivery");
  assert.match(cli("resume", { task_id: "task-b", attempt_id: byId()["task-b"].attempt_id }).reason, /correction barrier/);
  assert.equal(waitSettled(project, bin).ok, true);
  status = cli("status");
  assert.equal(byId()["task-a"].status, "ready", `${byId()["task-a"].reason} ${JSON.stringify(status.diagnostics?.["task-a"] ?? {})}`);
  const resumedArgv = JSON.parse(fs.readFileSync(`${scenarioFile}.task-a.argv.1.json`, "utf8"));
  assert.equal(resumedArgv.resumed, true, "the correction resumes the same lane session");
  assert.equal(resumedArgv.sessionId, firstA.sessionId);
  // 9. Reintegrate a, then reconcile c on the host and reintegrate it.
  assert.equal(cli("integrate", { task_id: "task-a", attempt_id: byId()["task-a"].attempt_id, expected_head: byId()["task-a"].child_head }).ok, true);
  status = cli("status");
  const cBefore = byId()["task-c"].child_head;
  const resumedC = cli("resume", { task_id: "task-c", attempt_id: byId()["task-c"].attempt_id, instruction: "Recapture after the corrected dependency." });
  assert.equal(resumedC.ok, true, resumedC.reason);
  const cWorktree = byId()["task-c"].worktree;
  assert.equal(fs.readFileSync(path.join(cWorktree, "src/a/index.mjs"), "utf8").includes("corrected"), true, "the host merged the corrected dependency into c");
  assert.equal(waitSettled(project, bin).ok, true);
  status = cli("status");
  assert.equal(byId()["task-c"].status, "ready", `${byId()["task-c"].reason} ${JSON.stringify(status.diagnostics?.["task-c"] ?? {})}`);
  assert.notEqual(byId()["task-c"].child_head, cBefore);
  assert.equal(cli("integrate", { task_id: "task-c", attempt_id: byId()["task-c"].attempt_id, expected_head: byId()["task-c"].child_head }).ok, true);
  status = cli("status");

  // 10. Delivery opens only with every receipt valid at the final HEAD.
  assert.deepEqual(status.tasks.map((task) => task.status), ["integrated", "integrated", "integrated"]);
  assert.equal(pushAllowed(project), true);
  const head = git(project.root, "rev-parse", "HEAD");
  const evidence = readAllIntegratedTaskEvidence({ projectRoot: project.root, sessionId: project.sessionId, featureId: FEATURE, headSha: head, tasks });
  assert.equal(evidence.ok, true, evidence.reason);
  const registry = JSON.parse(fs.readFileSync(path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json"), "utf8"));
  assert.equal(registry.correction_barrier, undefined);
  assert.equal(registry.tasks["task-a"].integration_history.length, 1);
  assert.equal(registry.tasks["task-c"].reconciliations.length, 1);
  assert.equal(git(project.root, "status", "--porcelain", "--untracked-files=no"), "");
  // Nothing is ever cleaned up.
  for (const entry of Object.values(registry.tasks)) assert.equal(fs.existsSync(entry.worktree), true);

  // Forged receipts are rejected on read: hashes alone never prove ancestry or identity.
  const registryFile = path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json");
  const pristine = fs.readFileSync(registryFile, "utf8");
  const read = () => readIntegratedTaskEvidence({ projectRoot: project.root, sessionId: project.sessionId, featureId: FEATURE, taskId: "task-b", headSha: head });
  const forge = (mutate) => {
    const forged = JSON.parse(pristine);
    mutate(forged.tasks["task-b"]);
    fs.writeFileSync(registryFile, JSON.stringify(forged));
    const result = read();
    fs.writeFileSync(registryFile, pristine);
    return result;
  };
  assert.equal(read().ok, true);
  const orphan = git(project.root, "commit-tree", "-m", "orphan", git(project.root, "rev-parse", "HEAD^{tree}"));
  assert.match(forge((entry) => { entry.integration.integrated_head = orphan; }).reason, /not ancestral/);
  assert.match(forge((entry) => {
    entry.result.context_return = { version: 1, kind: "task-context-return", session_id: entry.result.session_id, task_id: "task-b",
      head_sha: entry.result.child_head, content: "forged", sha256: "0".repeat(64) };
    entry.integration.result_sha256 = hashTaskReceipt(entry.result);
  }).reason, /inspection receipt is incomplete/);
  assert.match(forge((entry) => {
    entry.result.child_head = orphan;
    entry.integration.child_head = orphan;
    entry.integration.result_sha256 = hashTaskReceipt(entry.result);
  }).reason, /not ancestral|two-parent|changed-path|receipt is incomplete/);
  assert.match(forge((entry) => { entry.result.changed_paths = ["src/b/other.mjs"]; entry.integration.result_sha256 = hashTaskReceipt(entry.result); }).reason, /changed-path receipt no longer matches Git/);
  assert.equal(read().ok, true, "the pristine registry still validates");
});

test("e2e: aborting the CLI wait never stops a running lane", { timeout: 300_000 }, async (t) => {
  const [a] = defaultTasks();
  const project = createVendoredTaskProject(t, { tasks: [a] });
  const { bin } = writeFakeClaude(project, { tasks: { "task-a": { launches: [{ steps: [{ sleep: 2500 }, ...laneSteps({ task: a })] }] } } });
  assert.equal(tasksCli(project, "dispatch", { task_ids: ["task-a"] }, { claudeBin: bin }).ok, true);
  const waiter = tasksCliChild(project, "wait", { timeout_seconds: 120 }, { CLAUDE_HARNESS_CLAUDE_BIN: bin });
  let output = "";
  waiter.stdout.on("data", (chunk) => { output += chunk; });
  await new Promise((resolve) => setTimeout(resolve, 600));
  waiter.kill("SIGINT");
  await new Promise((resolve) => waiter.on("close", resolve));
  assert.equal(JSON.parse(output).wait, "aborted");
  const settled = waitSettled(project, bin);
  assert.equal(settled.tasks[0].status, "ready", settled.tasks[0].reason);
});
