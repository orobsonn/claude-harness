/**
 * @description LIVE smoke of parallel task lanes with the real `claude` CLI (opt-in, costs tokens).
 * Runs only when `claude` is on PATH and CLAUDE_HARNESS_LIVE_TASKS=1. Three trivial LIGHT tasks run
 * in three simultaneous real lanes inside a temp consumer with the harness vendored by vendor-core;
 * the host must reach `ready` for each and integrate them. Peak RSS of the lanes, wall time, tokens
 * and cost are printed (and written to $CLAUDE_HARNESS_LIVE_REPORT when set).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { planTask } from "./lib/__fixtures__/task-fixture.mjs";
import { createVendoredTaskProject, tasksCliAsync } from "./lib/__fixtures__/task-e2e.mjs";

/** @returns {false|string} node:test's `skip` value: false to run, a reason string to skip. */
function skipReason() {
  if (process.env.CLAUDE_HARNESS_LIVE_TASKS !== "1") return "set CLAUDE_HARNESS_LIVE_TASKS=1 to run the live lane smoke (uses real tokens)";
  if (spawnSync("claude", ["--version"], { encoding: "utf8" }).status !== 0) return "the claude CLI is not on PATH";
  return false;
}

function laneRss(root) {
  let total = 0;
  for (const pid of fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (!cwd.startsWith(root) || !/claude/.test(cmd) || !cmd.includes("-p")) continue;
      const rss = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+) kB/m);
      if (rss) total += Number(rss[1]);
    } catch { /* process ended */ }
  }
  return total;
}

test("LIVE: three real claude -p lanes reach ready and integrate", { skip: skipReason(), timeout: 60 * 60 * 1000 }, async (t) => {
  const tasks = ["alpha", "beta", "gamma"].map((name) => planTask(`task-${name}`, [`src/${name}`], {
    title: `Value ${name}`,
    spec: `Create src/${name}/index.mjs exporting a function value() that returns the string "${name}".`,
    locked_tests: [{ test_path: `test/${name}.test.mjs`, assertion: `Given src/${name}/index.mjs, When value() is called, Then it returns the string "${name}" (node:test, import the module with a relative path from test/)` }],
  }));
  const project = createVendoredTaskProject(t, { tasks, mode: "light", triageMode: "LIGHT" });
  const started = Date.now();
  const dispatched = await tasksCliAsync(project, "dispatch", { task_ids: tasks.map((task) => task.id) });
  assert.equal(dispatched.ok, true, dispatched.reason);
  let peakRss = 0;
  const sampler = setInterval(() => { peakRss = Math.max(peakRss, laneRss(project.root)); }, 2000);
  let status;
  try {
    for (let round = 0; round < 12; round += 1) {
      status = await tasksCliAsync(project, "wait", { compact: true });
      if (!status.ok || !status.tasks.some((task) => task.status === "running")) break;
    }
  } finally {
    clearInterval(sampler);
  }
  status = await tasksCliAsync(project, "status");
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cost_usd: 0 };
  for (const task of status.tasks) {
    for (const launch of task.launches) {
      for (const line of fs.readFileSync(launch.events_path, "utf8").split("\n").filter(Boolean)) {
        try {
          const event = JSON.parse(line);
          if (event.type !== "result") continue;
          for (const key of Object.keys(usage).filter((k) => k !== "cost_usd")) usage[key] += event.usage?.[key] ?? 0;
          usage.cost_usd += event.total_cost_usd ?? 0;
        } catch { /* partial line */ }
      }
    }
  }
  const report = {
    wall_seconds: Math.round((Date.now() - started) / 1000),
    peak_lane_rss_kb: peakRss,
    usage,
    tasks: status.tasks.map((task) => ({ task_id: task.task_id, status: task.status, reason: task.reason ?? null, launches: task.launches.length })),
    diagnostics: status.diagnostics ?? null,
  };
  if (process.env.CLAUDE_HARNESS_LIVE_REPORT) fs.writeFileSync(process.env.CLAUDE_HARNESS_LIVE_REPORT, JSON.stringify(report, null, 2));
  t.diagnostic(JSON.stringify(report));
  for (const task of status.tasks) assert.equal(task.status, "ready", `${task.task_id}: ${task.reason}`);
  for (const task of status.tasks) {
    const integrated = await tasksCliAsync(project, "integrate", { task_id: task.task_id, attempt_id: task.attempt_id, expected_head: task.child_head });
    assert.equal(integrated.ok, true, integrated.reason);
  }
  for (const task of tasks) assert.ok(fs.existsSync(path.join(project.root, task.scope_paths[0], "index.mjs")), `${task.id} product is in the aggregate`);
});
