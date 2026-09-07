#!/usr/bin/env node
/** One detached process group per task launch. No LLM scheduling lives here. */
import fs from "node:fs";
import { spawn } from "node:child_process";
import {
  taskProcessIdentity,
  taskGroupMembers,
  writeTaskJson,
} from "../lib/task-process.mjs";
import { verifyTaskRuntime } from "../lib/task-runtime-assets.mjs";

const job = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
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
let stopping = false;
let timedOut = false;
let killTimer;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const member of taskGroupMembers(process.pid))
    if (member.pid !== process.pid) {
      try {
        process.kill(member.pid, "SIGTERM");
      } catch {}
    }
  killTimer = setTimeout(() => {
    for (const member of taskGroupMembers(process.pid))
      if (member.pid !== process.pid) {
        try {
          process.kill(member.pid, "SIGKILL");
        } catch {}
      }
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
const child = spawn(job.command, job.args, {
  cwd: job.cwd,
  env,
  stdio: ["ignore", output, errors],
});
let spawnError;
child.on("error", (error) => {
  spawnError = error.message;
});
child.on("close", async (exitCode, signal) => {
  // Grandchildren may outlive the direct command. Keep the deadline supervising them.
  while (
    taskGroupMembers(process.pid).some((member) => member.pid !== process.pid)
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
