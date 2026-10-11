/**
 * @description Hermetic e2e of the Orca backend: the global parent runs "inside" an Orca workspace
 * (ORCA_WORKTREE_ID), so each lane is an Orca child worktree created at the exact base with the
 * parent as lineage and runs in an Orca terminal with Orca's pane variables. A scripted `orca`
 * (fake-orca.mjs) does real `git worktree add` and runs the terminal command detached; only `claude`
 * and `orca` are fake. The host still owns readiness, integration and receipts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultTasks, git } from "./lib/__fixtures__/task-fixture.mjs";
import { createVendoredTaskProject, laneSteps, tasksCli, writeFakeClaude } from "./lib/__fixtures__/task-e2e.mjs";

const FAKE_ORCA = fileURLToPath(new URL("./lib/__fixtures__/fake-orca.mjs", import.meta.url));
const REPO_ID = "7b05ebcb-0000-4000-8000-000000000001";

function orcaEnvironment(t, project) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-fake-orca-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.chmodSync(FAKE_ORCA, 0o755);
  const env = {
    ORCA_WORKTREE_ID: `${REPO_ID}::${project.root}`,
    CLAUDE_HARNESS_ORCA_CLI: FAKE_ORCA,
    FAKE_ORCA_STATE: path.join(dir, "state.json"),
    FAKE_ORCA_PARENT: project.root,
    FAKE_ORCA_REPO_ID: REPO_ID,
    FAKE_ORCA_WORKSPACES: path.join(dir, "workspaces"),
  };
  return { env, dir, state: () => JSON.parse(fs.readFileSync(env.FAKE_ORCA_STATE, "utf8")) };
}

test("e2e (Orca): lanes are Orca child worktrees and terminals; the host still decides and integrates", { timeout: 900_000 }, async (t) => {
  const tasks = defaultTasks().slice(0, 2);
  const [a, b] = tasks;
  const project = createVendoredTaskProject(t, { tasks });
  const orca = orcaEnvironment(t, project);
  const { bin } = writeFakeClaude(project, { tasks: {
    "task-a": { launches: [{ steps: laneSteps({ task: a }) }, { steps: [{ text: "Nada a corrigir." }] }] },
    "task-b": { launches: [{ steps: laneSteps({ task: b }) }] },
  } });
  const cli = (action, params, env = orca.env) => tasksCli(project, action, params, { claudeBin: bin, env });
  const settle = () => {
    for (let index = 0; index < 10; index += 1) {
      const result = cli("wait", { timeout_seconds: 120 });
      if (!result.ok || !result.tasks.some((task) => task.status === "running")) return result;
    }
    return null;
  };

  const dispatched = cli("dispatch", { task_ids: ["task-a", "task-b"] });
  assert.equal(dispatched.ok, true, dispatched.reason);
  const placed = orca.state();
  assert.equal(placed.worktrees.length, 2, "one Orca child worktree per lane");
  assert.equal(placed.terminals.length, 2, "one Orca terminal per lane");
  const create = placed.calls.find((call) => call[0] === "worktree" && call[1] === "create");
  const base = git(project.root, "rev-parse", "HEAD");
  for (const [flag, value] of [["--base-branch", base], ["--parent-worktree", `id:${REPO_ID}::${project.root}`], ["--setup", "skip"]]) {
    assert.equal(create[create.indexOf(flag) + 1], value, flag);
  }
  assert.match(create[create.indexOf("--comment") + 1], /^Harness task task-[ab]; attempt [0-9a-f-]{36}$/);
  assert.ok(placed.terminals.every((terminal) => /^task-[ab] · implementação$/.test(terminal.title)));
  assert.ok(placed.terminals.every((terminal) => terminal.command.startsWith("exec '")), "the worker command is shell-quoted");

  const settled = settle();
  assert.equal(settled.ok, true, settled?.reason);
  const status = cli("status");
  const byId = Object.fromEntries(status.tasks.map((task) => [task.task_id, task]));
  for (const id of ["task-a", "task-b"]) {
    const task = byId[id];
    assert.equal(task.status, "ready", `${id}: ${task.reason} ${JSON.stringify(status.diagnostics?.[id] ?? {}).slice(0, 400)}`);
    const worktree = orca.state().worktrees.find((item) => item.id === task.orca.worktree_id);
    assert.equal(task.worktree, worktree.path, "the lane runs in the Orca worktree");
    assert.match(task.branch, /^orca\//, "Orca chose the branch");
    assert.ok(task.run_dir.startsWith(fs.realpathSync(project.lanes)), "the run dir stays in the host lane root");
    assert.match(task.launches[0].orca.terminal_handle, /^term_/);
    assert.equal(task.launches[0].pid, null, "an Orca terminal launch has no host-spawned pid");
    // The terminal shows a readable, sanitized progress feed of the lane.
    const terminal = orca.state().terminals.find((item) => item.handle === task.launches[0].orca.terminal_handle);
    const feed = fs.readFileSync(path.join(orca.dir, terminal.log), "utf8");
    assert.match(feed, /▶ lane /);
    assert.match(feed, /• Agent executor · haiku/);
    assert.match(feed, /■ success/);
  }
  const registry = JSON.parse(fs.readFileSync(path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json"), "utf8"));
  assert.deepEqual(registry.orca_parent, { worktree_id: `${REPO_ID}::${project.root}`, instance_id: "inst-parent", repo_id: REPO_ID, path: project.root, host_id: "local", project_id: null, project_host_setup_id: null });

  // Integration is the host's, exactly as in local mode.
  for (const id of ["task-a", "task-b"]) {
    const integrated = cli("integrate", { task_id: id, attempt_id: byId[id].attempt_id, expected_head: byId[id].child_head });
    assert.equal(integrated.ok, true, integrated.reason);
  }
  assert.ok(fs.existsSync(path.join(project.root, "src/a/index.mjs")) && fs.existsSync(path.join(project.root, "src/b/index.mjs")));

  // A pinned registry never falls back to local: work outside the Orca workspace is refused, observation is not.
  const outside = { ...orca.env, ORCA_WORKTREE_ID: "" };
  assert.equal(cli("status", undefined, outside).ok, true);
  assert.match(cli("resume", { task_id: "task-a", attempt_id: byId["task-a"].attempt_id, instruction: "x" }, outside).reason, /Orca workspace/);
  assert.match(cli("resume", { task_id: "task-a", attempt_id: byId["task-a"].attempt_id, instruction: "x" }, { ...orca.env, ORCA_WORKTREE_ID: `${REPO_ID}::/elsewhere` }).reason, /does not belong to this global worktree/);
  // Resume reuses the same Orca worktree and opens a new terminal there.
  const resumed = cli("resume", { task_id: "task-a", attempt_id: byId["task-a"].attempt_id, instruction: "revalide" });
  assert.equal(resumed.ok, true, resumed.reason);
  const after = orca.state();
  assert.equal(after.worktrees.length, 2, "no second worktree on resume");
  assert.equal(after.calls.filter((call) => call[1] === "create" && call[0] === "worktree").length, 2);
  assert.equal(after.terminals.at(-1).title, "task-a · retomada");
  assert.equal(after.terminals.at(-1).worktreeId, byId["task-a"].orca.worktree_id);
  settle();
});

test("e2e (Orca): an unresolved Orca create is never retried blindly", { timeout: 300_000 }, async (t) => {
  const tasks = defaultTasks().slice(0, 1);
  const project = createVendoredTaskProject(t, { tasks });
  const orca = orcaEnvironment(t, project);
  const { bin } = writeFakeClaude(project, { tasks: {} });
  const failed = tasksCli(project, "dispatch", { task_ids: ["task-a"] }, { claudeBin: bin, env: { ...orca.env, FAKE_ORCA_FAIL_CREATE: "1" } });
  assert.equal(failed.tasks[0].status, "blocked");
  assert.match(failed.tasks[0].reason, /Orca did not return a successful structured result|Command failed/);
  assert.equal(failed.tasks[0].orca.create_requested, true, "the create request is journaled before it is sent");
  const retry = tasksCli(project, "resume", { task_id: "task-a", attempt_id: failed.tasks[0].attempt_id }, { claudeBin: bin, env: orca.env });
  assert.equal(retry.ok, false);
  assert.match(retry.reason, /Orca worktree creation is unresolved; inspect this attempt/);
  const creates = orca.state().calls.filter((call) => call[0] === "worktree" && call[1] === "create");
  assert.equal(creates.length, 1, "no second create while the first is uncertain");
});
