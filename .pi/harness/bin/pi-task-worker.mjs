#!/usr/bin/env node
/** One detached process group per task launch. No LLM scheduling lives here. */
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  renderTaskEventLine,
  taskProcessIdentity,
  taskGroupMembers,
  writeTaskJson,
} from "../lib/task-process.mjs";
import { verifyTaskRuntime } from "../lib/task-runtime-assets.mjs";

const childMode = process.argv[2] === "--child";
const job = JSON.parse(
  fs.readFileSync(childMode ? process.argv[3] : process.argv[2], "utf8"),
);
if (childMode) {
  const childJob = job;
  const target = spawn(childJob.command, childJob.args, {
    cwd: childJob.cwd,
    env: process.env,
    stdio: "inherit",
  });
  target.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 127;
  });
  target.on("close", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? process.exitCode ?? 1);
  });
} else {
const identity = taskProcessIdentity(process.pid);
writeTaskJson(job.process_path, {
  version: 1,
  run_id: job.run_id,
  pid: process.pid,
  process_start_ticks: identity.start,
  started_at: new Date().toISOString(),
  ...(job.runtime?.sha256 ? { run_runtime_sha256: job.runtime.sha256 } : {}),
});
const output = fs.openSync(job.events_path, "a", 0o600);
const errors = fs.openSync(job.stderr_path, "a", 0o600);
const env = { ...process.env };
// A task is a fresh local parent, never an inherited native subagent.
for (const key of Object.keys(env)) {
  if (
    key.startsWith("HARNESS_DISPATCH_") ||
    key.startsWith("PI_SUBAGENT_") ||
    key === "PI_HARNESS_RESUME"
  )
    delete env[key];
}
delete env.PI_HARNESS_TASK_RUN;
if (!job.terminal_mode)
  for (const key of Object.keys(env)) if (key.startsWith("ORCA_")) delete env[key];
let stopping = false;
let timedOut = false;
let killTimer;
let processGroup = null;
function terminateGroup(signal) {
  for (const member of processGroup ? taskGroupMembers(processGroup) : []) {
    try {
      process.kill(member.pid, signal);
    } catch {}
  }
}
function stop() {
  if (stopping) return;
  stopping = true;
  terminateGroup("SIGTERM");
  killTimer = setTimeout(() => {
    terminateGroup("SIGKILL");
  }, 1000);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
const deadline = setTimeout(() => {
  timedOut = true;
  stop();
}, job.timeoutMs);
// Unit worker fixtures may omit runtime. Production coordination always supplies the immutable
// manifest, which is re-read immediately before launching the provider-bearing child process.
if (job.runtime !== undefined && !verifyTaskRuntime(job.runtime).ok) {
  clearTimeout(deadline);
  fs.writeSync(errors, "task runtime verification failed\n");
  fs.closeSync(output);
  fs.closeSync(errors);
  writeTaskJson(job.result_path, {
    version: 1,
    run_id: job.run_id,
    pid: process.pid,
    exitCode: 1,
    signal: null,
    timedOut: false,
    ended_at: new Date().toISOString(),
    error: "task runtime verification failed",
    run_runtime_sha256: job.runtime?.sha256,
  });
  process.exit(1);
}
const child = spawn(process.execPath, [process.argv[1], "--child", process.argv[2]], {
  cwd: job.cwd,
  env,
  detached: true,
  stdio: ["ignore", "pipe", errors],
});
let spawnError;
let outputBuffer = "";
child.stdout?.on("data", (chunk) => {
  fs.writeSync(output, chunk);
  outputBuffer += chunk.toString("utf8");
  const lines = outputBuffer.split("\n");
  outputBuffer = lines.pop() ?? "";
  for (const line of lines) {
    const rendered = renderTaskEventLine(line);
    if (rendered) process.stdout.write(rendered);
  }
});
child.on("spawn", () => {
  processGroup = child.pid;
  const childIdentity = taskProcessIdentity(child.pid);
  writeTaskJson(job.process_path, {
    version: 1,
    run_id: job.run_id,
    pid: process.pid,
    process_start_ticks: identity.start,
    process_group: child.pid,
    ...(childIdentity?.start
      ? { child_process_start_ticks: childIdentity.start }
      : {}),
    started_at: new Date().toISOString(),
    ...(job.runtime?.sha256 ? { run_runtime_sha256: job.runtime.sha256 } : {}),
  });
  if (stopping) terminateGroup("SIGTERM");
});
child.on("error", (error) => {
  spawnError = error.message;
});
child.on("close", async (exitCode, signal) => {
  // Grandchildren may outlive the direct command. Keep the deadline supervising them.
  while (
    processGroup && taskGroupMembers(processGroup).length > 0
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  clearTimeout(deadline);
  clearTimeout(killTimer);
  fs.closeSync(output);
  fs.closeSync(errors);
  writeTaskJson(job.result_path, {
    version: 1,
    run_id: job.run_id,
    pid: process.pid,
    exitCode,
    signal,
    timedOut,
    ended_at: new Date().toISOString(),
    ...(spawnError ? { error: spawnError } : {}),
    ...(job.runtime?.sha256 ? { run_runtime_sha256: job.runtime.sha256 } : {}),
  });
});
}
