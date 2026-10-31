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
    // The TUI lane's trust and transcript live in a private config dir, never the operator's.
    CLAUDE_CONFIG_DIR: path.join(dir, "claude-config"),
  };
  fs.mkdirSync(env.CLAUDE_CONFIG_DIR);
  fs.writeFileSync(path.join(env.CLAUDE_CONFIG_DIR, ".claude.json"), JSON.stringify({ numStartups: 3, projects: { "/elsewhere": { hasTrustDialogAccepted: true } } }));
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
  assert.ok(orca.state().calls.some((call) => call[0] === "terminal" && call[1] === "wait" && call.includes("--for") && call.includes("exit")),
    "the parent's wait used Orca's native terminal wait");
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
    // A new Orca attempt is an interactive TUI: the evidence came from the transcript and the
    // lane's own Stop hook ended it (exit 143 accepted only with the end-of-turn record).
    assert.equal(task.launches[0].presentation, "tui");
    const events = fs.readFileSync(task.launches[0].events_path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "system");
    assert.equal(events[0].presentation, "tui");
    assert.equal(events.at(-1).written_by, "lane-stop-hook");
    assert.ok(events.some((event) => event.type === "user" && event.tool_use_result?.status === "completed"), "Agent results come from the transcript");
    const result = JSON.parse(fs.readFileSync(path.join(path.dirname(task.launches[0].events_path), "result.json"), "utf8"));
    assert.equal(result.exitCode, 143, "the TUI ended by the lane's SIGTERM");
  }
  const config = JSON.parse(fs.readFileSync(path.join(orca.env.CLAUDE_CONFIG_DIR, ".claude.json"), "utf8"));
  assert.equal(config.projects[project.root].hasTrustDialogAccepted, true, "the parent repository is trusted by default");
  assert.equal(config.numStartups, 3, "the rest of the config is preserved");
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
  const foreign = cli("resume", { task_id: "task-a", attempt_id: byId["task-a"].attempt_id, instruction: "x" },
    { ...orca.env, ORCA_WORKTREE_ID: `${REPO_ID}::/elsewhere` });
  assert.equal(foreign.ok, false);
  assert.match(foreign.reason, /worktree show --worktree id:.*\/elsewhere/,
    "an unknown exact ID is refused at lookup, without resolving another workspace by path");
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

test("e2e (Orca TUI): a lane that stops before its capture is continued once per state, then ends by itself", { timeout: 600_000 }, async (t) => {
  const tasks = defaultTasks().slice(0, 1);
  const [a] = tasks;
  const project = createVendoredTaskProject(t, { tasks });
  const orca = orcaEnvironment(t, project);
  const full = laneSteps({ task: a });
  const executorAt = full.findIndex((step) => /active-scope/.test(step.bash ?? ""));
  const { bin, scenarioFile } = writeFakeClaude(project, { tasks: {
    // The model stops after the freeze; the continuation brings it back to finish the task.
    "task-a": { launches: [{ steps: [...full.slice(0, executorAt), { text: "Testes congelados; paro aqui." }], continuations: [full.slice(executorAt)] }] },
  } });
  const cli = (action, params) => tasksCli(project, action, params, { claudeBin: bin, env: orca.env });
  assert.equal(cli("dispatch", { task_ids: ["task-a"] }).ok, true);
  let status;
  for (let index = 0; index < 10; index += 1) {
    status = cli("wait", { timeout_seconds: 120 });
    if (!status.tasks.some((task) => task.status === "running")) break;
  }
  const task = cli("status").tasks[0];
  assert.equal(task.status, "ready", task.reason);
  const stops = fs.readFileSync(`${scenarioFile}.task-a.stops`, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.match(stops[0].blocked, /Continue this same task through the remaining implementation/);
  assert.equal(stops.at(-1).blocked, null, "once the capture and review exist the lane is released");
  assert.equal(stops.length, 2);
});

test("e2e (Orca TUI): a SIGTERM exit without the lane's end-of-turn record is never success", { timeout: 600_000 }, async (t) => {
  const tasks = defaultTasks().slice(0, 1);
  const project = createVendoredTaskProject(t, { tasks });
  const orca = orcaEnvironment(t, project);
  const { bin } = writeFakeClaude(project, { tasks: {
    "task-a": { launches: [{ steps: laneSteps({ task: tasks[0] }), skip_stop_hooks: true, idle_ms: 200, idle_exit: 143 }] },
  } });
  const cli = (action, params) => tasksCli(project, action, params, { claudeBin: bin, env: orca.env });
  assert.equal(cli("dispatch", { task_ids: ["task-a"] }).ok, true);
  for (let index = 0; index < 10; index += 1) {
    if (!cli("wait", { timeout_seconds: 120 }).tasks.some((task) => task.status === "running")) break;
  }
  const status = cli("status");
  assert.equal(status.tasks[0].status, "blocked");
  assert.match(status.tasks[0].reason, /latest task launch did not exit successfully|did not finish successfully/);
});
