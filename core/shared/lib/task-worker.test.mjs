import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  liveTrackedProcesses,
  readTaskProcess,
  startTaskProcess,
  taskDescendants,
  taskProcessIdentity,
} from "./task-process.mjs";

const WORKER_MODULE = pathToFileURL(path.join(import.meta.dirname, "task-worker.mjs")).href;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const linux = process.platform === "linux";

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "shared-task-worker-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A host bin exactly like a real one: fixed options, real shared supervisor. */
function hostWorker(dir, { trackDescendants = false, killGraceMs = 300 } = {}) {
  const file = path.join(dir, `host-worker-${trackDescendants ? "track" : "plain"}.mjs`);
  fs.writeFileSync(file, `import { runTaskWorker } from ${JSON.stringify(WORKER_MODULE)};
runTaskWorker({
  trackDescendants: ${trackDescendants},
  trackIntervalMs: 50,
  killGraceMs: ${killGraceMs},
  verifyRuntime: (runtime) => ({ ok: runtime.sha256 === "a".repeat(64) }),
  renderEventLine: (line) => line.startsWith("PUBLIC:") ? line + "\\n" : "",
  childEnvironment(env) {
    for (const key of Object.keys(env)) if (key.startsWith("HOST_SECRET_")) delete env[key];
    env.HOST_ADDED = "1";
    return env;
  },
});
`);
  return file;
}

async function until(predicate, label, attempts = 300) {
  for (let index = 0; index < attempts; index += 1) {
    const value = predicate();
    if (value) return value;
    await pause(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}
const terminal = (launch) => until(() => {
  const state = readTaskProcess(launch);
  return state.terminal ? state : null;
}, "terminal launch");
const alive = (pid, start) => liveTrackedProcesses([{ pid, start }]).length > 0;

test("a generic host worker persists identity, applies the host env policy and records a terminal result", async (t) => {
  const dir = fixture(t);
  const marker = path.join(dir, "env.json");
  process.env.HOST_SECRET_TOKEN = "must-not-cross";
  t.after(() => { delete process.env.HOST_SECRET_TOKEN; });
  const launch = await startTaskProcess({
    workerPath: hostWorker(dir),
    jobDir: path.join(dir, "job"),
    runId: "generic-1",
    cwd: dir,
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({secret: process.env.HOST_SECRET_TOKEN ?? null, added: process.env.HOST_ADDED, cwd: process.cwd()})); console.log("PUBLIC: hi"); console.log("private")`],
  });
  assert.equal(launch.worker_path, path.join(dir, "host-worker-plain.mjs"));
  assert.equal(launch.descendants_path, undefined);
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(end.result.exitCode, 0);
  assert.equal(end.result.timedOut, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { secret: null, added: "1", cwd: dir });
  const record = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
  assert.equal(record.run_id, "generic-1");
  assert.match(record.process_start_ticks, /\S/);
  assert.ok(Number.isInteger(record.process_group));
  assert.equal(fs.statSync(launch.descriptor_path).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(launch.events_path, "utf8"), "PUBLIC: hi\nprivate\n");
});

test("startTaskProcess refuses a relative worker path and an unbounded deadline before any effect", async (t) => {
  const dir = fixture(t);
  await assert.rejects(startTaskProcess({ workerPath: "worker.mjs", jobDir: path.join(dir, "a"), runId: "r", cwd: dir, command: "x", args: [] }), /absolute/);
  await assert.rejects(startTaskProcess({ workerPath: hostWorker(dir), jobDir: path.join(dir, "b"), runId: "r", cwd: dir, command: "x", args: [], timeoutMs: 86_400_001 }), /24 hours/);
  assert.equal(fs.existsSync(path.join(dir, "a")), false);
  assert.equal(fs.existsSync(path.join(dir, "b")), false);
});

test("a detached worker outlives the process that created it", { skip: !linux && "needs /proc" }, async (t) => {
  const dir = fixture(t);
  const workerPath = hostWorker(dir);
  const handleFile = path.join(dir, "launch.json");
  const creatorScript = path.join(dir, "creator.mjs");
  fs.writeFileSync(creatorScript, `import { startTaskProcess } from ${JSON.stringify(pathToFileURL(path.join(import.meta.dirname, "task-process.mjs")).href)};
import fs from "node:fs";
const launch = await startTaskProcess({ workerPath: ${JSON.stringify(workerPath)}, jobDir: ${JSON.stringify(path.join(dir, "job"))},
  runId: "outlive", cwd: ${JSON.stringify(dir)}, command: process.execPath, args: ["-e", "setTimeout(() => {}, 600)"] });
fs.writeFileSync(${JSON.stringify(handleFile)}, JSON.stringify(launch));
process.exit(0);
`);
  execFileSync(process.execPath, [creatorScript]);
  const launch = JSON.parse(fs.readFileSync(handleFile, "utf8"));
  assert.equal(readTaskProcess(launch).running, true, "the worker keeps running after its creator exited");
  const end = await terminal(launch);
  assert.equal(end.result.exitCode, 0);
});

test("SIGTERM and SIGHUP on the supervisor kill the whole child group without orphans", { skip: !linux && "needs /proc" }, async (t) => {
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    const dir = fixture(t);
    const launch = await startTaskProcess({
      workerPath: hostWorker(dir),
      jobDir: path.join(dir, "job"),
      runId: `kill-${signal}`,
      cwd: dir,
      command: "/bin/sh",
      args: ["-c", "sleep 60 & sleep 60 & wait"],
    });
    const record = await until(() => {
      const value = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
      return Number.isInteger(value.process_group) ? value : null;
    }, "group registration");
    await until(() => taskDescendants(record.process_group).filter((item) => item.state !== "Z").length >= 3, "sleepers");
    const members = taskDescendants(record.process_group).map((item) => ({ pid: item.pid, start: item.start }));
    process.kill(record.pid, signal);
    const end = await terminal(launch);
    assert.equal(end.result.signal !== null || end.result.exitCode !== 0, true, signal);
    for (const member of members) assert.equal(alive(member.pid, member.start), false, `${signal} left ${member.pid}`);
  }
});

test("a timeout is a terminal failure that marks timedOut", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({
    workerPath: hostWorker(dir),
    jobDir: path.join(dir, "job"),
    runId: "timeout",
    cwd: dir,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 60000)"],
    timeoutMs: 200,
  });
  const end = await terminal(launch);
  assert.equal(end.result.timedOut, true);
  assert.notEqual(end.result.exitCode, 0);
});

test("a changed runtime is refused before the child runs", async (t) => {
  const dir = fixture(t);
  const marker = path.join(dir, "ran");
  const launch = await startTaskProcess({
    workerPath: hostWorker(dir),
    jobDir: path.join(dir, "job"),
    runId: "runtime",
    cwd: dir,
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`],
    runtime: { sha256: "b".repeat(64) },
  });
  const end = await terminal(launch);
  assert.equal(end.result.exitCode, 1);
  assert.equal(end.result.error, "task runtime verification failed");
  assert.equal(fs.existsSync(marker), false);
});

test("descendants that leave the group keep the launch running and die after the grace period", { skip: !linux && "needs /proc" }, async (t) => {
  const dir = fixture(t);
  const pidFile = path.join(dir, "detached.pid");
  // The direct command starts a sleeper in its OWN session (like Claude Code's Bash tool), then exits.
  const launch = await startTaskProcess({
    workerPath: hostWorker(dir, { trackDescendants: true }),
    jobDir: path.join(dir, "job"),
    runId: "descendants",
    cwd: dir,
    command: process.execPath,
    args: ["-e", `const c = require("node:child_process").spawn("sleep", ["60"], { detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); setTimeout(() => {}, 400);`],
    trackDescendants: true,
  });
  assert.equal(launch.descendants_path, path.join(dir, "job", "descendants.json"));
  const sleeper = await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")), "detached sleeper");
  const identity = taskProcessIdentity(sleeper);
  const record = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
  assert.notEqual(identity.group, record.process_group, "the sleeper really left the child group");
  await until(() => {
    try { return JSON.parse(fs.readFileSync(launch.descendants_path, "utf8")).processes.some((item) => item.pid === sleeper); } catch { return false; }
  }, "descendant recorded");
  await pause(700); // the direct command has exited; only the detached sleeper remains
  assert.equal(readTaskProcess(launch).running, true, "a live detached descendant keeps the launch running");
  process.kill(JSON.parse(fs.readFileSync(launch.process_path, "utf8")).pid, "SIGTERM");
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(alive(sleeper, identity.start), false, "the detached descendant was killed after the grace period");
});

test("after a supervisor crash, recorded live descendants still keep the launch running", { skip: !linux && "needs /proc" }, async (t) => {
  const dir = fixture(t);
  const pidFile = path.join(dir, "detached.pid");
  const launch = await startTaskProcess({
    workerPath: hostWorker(dir, { trackDescendants: true }),
    jobDir: path.join(dir, "job"),
    runId: "crash",
    cwd: dir,
    command: process.execPath,
    args: ["-e", `const c = require("node:child_process").spawn("sleep", ["60"], { detached: true, stdio: "ignore" }); require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); setTimeout(() => {}, 300);`],
    trackDescendants: true,
  });
  const sleeper = await until(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")), "detached sleeper");
  const identity = taskProcessIdentity(sleeper);
  t.after(() => { try { process.kill(sleeper, "SIGKILL"); } catch {} });
  await until(() => {
    try { return JSON.parse(fs.readFileSync(launch.descendants_path, "utf8")).processes.some((item) => item.pid === sleeper); } catch { return false; }
  }, "descendant recorded");
  await pause(500);
  const supervisor = JSON.parse(fs.readFileSync(launch.process_path, "utf8")).pid;
  process.kill(supervisor, "SIGKILL");
  await until(() => !alive(supervisor, JSON.parse(fs.readFileSync(launch.process_path, "utf8")).process_start_ticks), "supervisor death");
  const observed = readTaskProcess(launch);
  assert.equal(observed.running, true, "the recorded detached descendant is still alive");
  process.kill(sleeper, "SIGKILL");
  await until(() => !alive(sleeper, identity.start), "sleeper death");
  const after = readTaskProcess(launch);
  assert.equal(after.terminal, true);
  assert.equal(after.ok, false, "no completion record was written by the crashed supervisor");
});

test("recorded descendants never match a reused pid", () => {
  const identityFn = (pid) => ({ pid, state: "S", start: "999" });
  assert.deepEqual(liveTrackedProcesses([{ pid: 4242, start: "100" }], identityFn), []);
  assert.equal(liveTrackedProcesses([{ pid: 4242, start: "999" }], identityFn).length, 1);
  assert.equal(liveTrackedProcesses([{ pid: 4242, start: "999" }], (pid) => ({ pid, state: "Z", start: "999" })).length, 0);
  assert.equal(liveTrackedProcesses([{ pid: 4242, start: "999" }], (pid) => ({ pid, unknown: true })).length, 1, "unknown identity fails closed as alive");
  assert.deepEqual(liveTrackedProcesses("garbage"), []);
});

test("readTaskProcess treats a launch with a live recorded descendant as running even with a valid result", () => {
  const launch = { run_id: "r", process_path: "p", result_path: "q", descendants_path: "d" };
  const files = {
    p: { version: 1, run_id: "r", pid: 10, process_start_ticks: "1", process_group: 11, child_process_start_ticks: "2" },
    q: { version: 1, run_id: "r", pid: 10, exitCode: 0, signal: null, timedOut: false, ended_at: "now" },
    d: { version: 1, run_id: "r", processes: [{ pid: 12, start: "3" }] },
  };
  const readJsonFn = (file) => files[file];
  const groupMembersFn = () => [];
  const identityFn = (pid) => pid === 12 ? { pid, state: "S", start: "3" } : null;
  assert.equal(readTaskProcess(launch, { readJsonFn, groupMembersFn, identityFn }).running, true);
  const gone = readTaskProcess(launch, { readJsonFn, groupMembersFn, identityFn: () => null });
  assert.equal(gone.terminal, true);
  assert.equal(gone.ok, true);
});
