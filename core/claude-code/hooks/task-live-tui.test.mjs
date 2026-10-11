/**
 * @description LIVE smoke of TUI task lanes (opt-in, costs tokens): the real `claude` CLI runs
 * INTERACTIVELY in a pseudo-terminal (the scripted `orca` wraps each terminal command in
 * `script -qec`, as an Orca terminal gives it a TTY). Runs only with CLAUDE_HARNESS_LIVE_TASKS=1,
 * `claude` and `script` on PATH. The host must reach `ready` from the transcript evidence, the
 * lane's own Stop hook must end each TUI, and the parent's wait must use `orca terminal wait`.
 * Trust for the temp project is recorded in the operator's Claude config and removed afterwards.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { planTask } from "./lib/__fixtures__/task-fixture.mjs";
import { createVendoredTaskProject, tasksCliAsync } from "./lib/__fixtures__/task-e2e.mjs";

const FAKE_ORCA = fileURLToPath(new URL("./lib/__fixtures__/fake-orca.mjs", import.meta.url));
const REPO_ID = "7b05ebcb-0000-4000-8000-00000000live";

function skipReason() {
  if (process.env.CLAUDE_HARNESS_LIVE_TASKS !== "1") return "set CLAUDE_HARNESS_LIVE_TASKS=1 to run the live TUI lane smoke (uses real tokens)";
  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) return "the claude CLI is not on PATH";
  if (spawnSync("script", ["--version"], { encoding: "utf8" }).status !== 0) return "script (util-linux) is not on PATH";
  return false;
}

/** Remove only this project's trust entry from the operator's Claude config (atomic rewrite). */
function forgetTrust(root) {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
  try {
    const config = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!config.projects?.[root]) return;
    delete config.projects[root];
    const temporary = `${file}.live-${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(config, null, 2), { mode: fs.statSync(file).mode & 0o777 });
    fs.renameSync(temporary, file);
  } catch { /* best effort */ }
}

test("LIVE: real interactive claude TUI lanes reach ready and integrate", { skip: skipReason(), timeout: 60 * 60 * 1000 }, async (t) => {
  const tasks = ["alpha", "beta"].map((name) => planTask(`task-${name}`, [`src/${name}`], {
    title: `Value ${name}`,
    spec: `Create src/${name}/index.mjs exporting a function value() that returns the string "${name}".`,
    locked_tests: [{ test_path: `test/${name}.test.mjs`, assertion: `Given src/${name}/index.mjs, When value() is called, Then it returns the string "${name}" (node:test, import the module with a relative path from test/)` }],
  }));
  const project = createVendoredTaskProject(t, { tasks, mode: "light", triageMode: "LIGHT" });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-live-orca-")));
  const laneTranscripts = new Set();
  t.after(() => {
    forgetTrust(project.root);
    // Only this run's lane transcript folders (one per lane worktree path), never anything else.
    for (const worktree of laneTranscripts) {
      const folder = path.join(os.homedir(), ".claude", "projects", worktree.replace(/[^A-Za-z0-9]/g, "-"));
      if (path.dirname(folder) === path.join(os.homedir(), ".claude", "projects")) fs.rmSync(folder, { recursive: true, force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.chmodSync(FAKE_ORCA, 0o755);
  const env = {
    ORCA_WORKTREE_ID: `${REPO_ID}::${project.root}`,
    CLAUDE_HARNESS_ORCA_CLI: FAKE_ORCA,
    FAKE_ORCA_STATE: path.join(dir, "state.json"),
    FAKE_ORCA_PARENT: project.root,
    FAKE_ORCA_REPO_ID: REPO_ID,
    FAKE_ORCA_WORKSPACES: path.join(dir, "workspaces"),
    FAKE_ORCA_PTY: "1",
    TERM: "xterm-256color",
  };
  const started = Date.now();
  const dispatched = await tasksCliAsync(project, "dispatch", { task_ids: tasks.map((task) => task.id) }, { env });
  assert.equal(dispatched.ok, true, dispatched.reason);
  let status;
  for (let round = 0; round < 12; round += 1) {
    status = await tasksCliAsync(project, "wait", { compact: true }, { env });
    if (!status.ok || !status.tasks.some((task) => task.status === "running")) break;
  }
  status = await tasksCliAsync(project, "status", undefined, { env });
  for (const task of status.tasks) laneTranscripts.add(task.worktree);
  const state = JSON.parse(fs.readFileSync(env.FAKE_ORCA_STATE, "utf8"));
  const report = {
    wall_seconds: Math.round((Date.now() - started) / 1000),
    orca_waits: state.calls.filter((call) => call[0] === "terminal" && call[1] === "wait").length,
    tasks: status.tasks.map((task) => ({ task_id: task.task_id, status: task.status, reason: task.reason ?? null, presentation: task.launches.at(-1)?.presentation })),
  };
  if (process.env.CLAUDE_HARNESS_LIVE_REPORT) fs.writeFileSync(process.env.CLAUDE_HARNESS_LIVE_REPORT, JSON.stringify({ ...report, diagnostics: status.diagnostics ?? null }, null, 2));
  if (process.env.CLAUDE_HARNESS_LIVE_ARTIFACTS) {
    for (const task of status.tasks) {
      const dest = path.join(process.env.CLAUDE_HARNESS_LIVE_ARTIFACTS, task.task_id);
      fs.mkdirSync(dest, { recursive: true });
      task.launches.forEach((launch, index) => { try { fs.copyFileSync(launch.events_path, path.join(dest, `events.${index}.jsonl`)); } catch { /* none */ } });
      for (const terminal of state.terminals) { try { fs.copyFileSync(path.join(dir, terminal.log), path.join(dest, terminal.log)); } catch { /* none */ } }
    }
  }
  t.diagnostic(JSON.stringify(report));
  assert.ok(report.orca_waits > 0, "the parent waited on Orca's native terminal wait");
  for (const task of status.tasks) {
    assert.equal(task.launches.at(-1).presentation, "tui");
    assert.equal(task.status, "ready", `${task.task_id}: ${task.reason}`);
  }
  for (const task of status.tasks) {
    const integrated = await tasksCliAsync(project, "integrate", { task_id: task.task_id, attempt_id: task.attempt_id, expected_head: task.child_head }, { env });
    assert.equal(integrated.ok, true, integrated.reason);
  }
  for (const task of tasks) assert.ok(fs.existsSync(path.join(project.root, task.scope_paths[0], "index.mjs")), `${task.id} product is in the aggregate`);
});
