/**
 * @description Host-neutral task supervisor: one detached process group per task launch. No LLM
 * scheduling lives here. A host bin calls `runTaskWorker` with its own environment policy, event
 * renderer and runtime verifier; the real command line comes from `job.json`, written by the host.
 *
 * Process tree: supervisor (`node <bin> <job.json>`) → shim (`node <bin> --child <job.json>`, its
 * own process group) → `job.command job.args` (cwd = job.cwd). The supervisor writes
 * process.json/result.json, enforces the deadline and kills the whole tree on SIGTERM/INT/HUP.
 * With `trackDescendants`, it also follows descendants that left the group (own session), records
 * their identities in `descendants.json` and does not finish while any of them is alive.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  liveTrackedProcesses,
  taskDescendants,
  taskGroupMembers,
  taskProcessIdentity,
  writeTaskJson,
} from "./task-process.mjs";

function precreatePrivateEventFile(file, descriptorPath) {
  const expected = path.join(
    path.dirname(path.resolve(descriptorPath)),
    "events.jsonl",
  );
  if (file !== expected)
    throw new Error("task event path does not match its descriptor directory");
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      noFollow,
    0o600,
  );
  try {
    const opened = fs.fstatSync(fd);
    const linked = fs.lstatSync(file);
    if (
      !opened.isFile() ||
      !linked.isFile() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino
    )
      throw new Error("task event path is not a stable regular file");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * @param {object} options
 * @param {string[]} [options.argv] - process.argv of the host bin.
 * @param {(env: Record<string,string>, job: object, descriptorPath: string) => Record<string,string>} options.childEnvironment -
 *   host env policy for the task (receives a copy of process.env; returns the env to launch with).
 * @param {(line: string) => string} [options.renderEventLine] - public progress echoed to stdout.
 * @param {(runtime: object) => { ok: boolean }} [options.verifyRuntime] - re-checked before launch.
 * @param {number} [options.killGraceMs] - SIGTERM → SIGKILL grace.
 * @param {boolean} [options.trackDescendants] - follow descendants outside the process group.
 * @param {number} [options.trackIntervalMs] - descendant sampling period.
 */
export function runTaskWorker({
  argv = process.argv,
  childEnvironment,
  renderEventLine = () => "",
  verifyRuntime,
  killGraceMs = 1000,
  trackDescendants = false,
  trackIntervalMs = 500,
}) {
  const childMode = argv[2] === "--child";
  const descriptorPath = childMode ? argv[3] : argv[2];
  const job = JSON.parse(
    fs.readFileSync(descriptorPath, "utf8"),
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
    return;
  }
  const identity = taskProcessIdentity(process.pid);
  writeTaskJson(job.process_path, {
    version: 1,
    run_id: job.run_id,
    pid: process.pid,
    process_start_ticks: identity.start,
    started_at: new Date().toISOString(),
    ...(job.runtime?.sha256 ? { run_runtime_sha256: job.runtime.sha256 } : {}),
  });
  const tuiPresentation = job.presentation === "tui";
  let output = null;
  if (tuiPresentation) precreatePrivateEventFile(job.events_path, descriptorPath);
  else output = fs.openSync(job.events_path, "a", 0o600);
  const errors = fs.openSync(job.stderr_path, "a", 0o600);
  const env = childEnvironment({ ...process.env }, job, descriptorPath);
  let stopping = false;
  let timedOut = false;
  let killTimer;
  let processGroup = null;
  // Descendants that left the group, keyed by pid with their start ticks (pid reuse never matches).
  const tracked = new Map();
  const descendantsPath = trackDescendants ? job.descendants_path : undefined;
  function recordDescendants() {
    if (!trackDescendants || !processGroup) return;
    let changed = false;
    try {
      for (const item of taskDescendants(processGroup)) {
        if (item.unknown || typeof item.start !== "string") continue;
        if (tracked.get(item.pid) !== item.start) {
          tracked.set(item.pid, item.start);
          changed = true;
        }
      }
    } catch {
      /* the next sample retries; group membership still bounds the lifecycle */
    }
    if (changed && typeof descendantsPath === "string")
      writeTaskJson(descendantsPath, {
        version: 1,
        run_id: job.run_id,
        processes: [...tracked].map(([pid, start]) => ({ pid, start })),
      });
  }
  const liveDescendants = () =>
    liveTrackedProcesses([...tracked].map(([pid, start]) => ({ pid, start })));
  function terminateGroup(signal) {
    for (const member of processGroup ? taskGroupMembers(processGroup) : []) {
      try {
        process.kill(member.pid, signal);
      } catch {}
    }
    // Detached tool processes are killed only after the grace period: on SIGTERM the
    // agent CLI cleans up its own tools, and an early kill would race that cleanup.
    if (signal === "SIGKILL")
      for (const item of liveDescendants()) {
        try {
          process.kill(item.pid, signal);
        } catch {}
      }
  }
  function stop() {
    if (stopping) return;
    stopping = true;
    recordDescendants();
    terminateGroup("SIGTERM");
    killTimer = setTimeout(() => {
      recordDescendants();
      terminateGroup("SIGKILL");
    }, killGraceMs);
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  process.on("SIGHUP", stop);
  const deadline = setTimeout(() => {
    timedOut = true;
    stop();
  }, job.timeoutMs);
  // Unit worker fixtures may omit runtime. Production coordination always supplies the immutable
  // manifest, which is re-read immediately before launching the provider-bearing child process.
  if (job.runtime !== undefined && verifyRuntime && !verifyRuntime(job.runtime).ok) {
    clearTimeout(deadline);
    fs.writeSync(errors, "task runtime verification failed\n");
    if (tuiPresentation) process.stderr.write("task runtime verification failed\n");
    if (output !== null) fs.closeSync(output);
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
  const child = spawn(process.execPath, [argv[1], "--child", argv[2]], {
    cwd: job.cwd,
    env,
    detached: true,
    stdio: tuiPresentation
      ? ["inherit", "inherit", "pipe"]
      : ["ignore", "pipe", errors],
  });
  let spawnError;
  let outputBuffer = "";
  let sampler;
  if (tuiPresentation) {
    child.stderr?.on("data", (chunk) => {
      fs.writeSync(errors, chunk);
      process.stderr.write(chunk);
    });
  } else {
    child.stdout?.on("data", (chunk) => {
      fs.writeSync(output, chunk);
      outputBuffer += chunk.toString("utf8");
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const rendered = renderEventLine(line);
        if (rendered) process.stdout.write(rendered);
      }
    });
  }
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
    if (trackDescendants) {
      recordDescendants();
      sampler = setInterval(recordDescendants, trackIntervalMs);
    }
    if (stopping) terminateGroup("SIGTERM");
  });
  child.on("error", (error) => {
    spawnError = error.message;
  });
  child.on("close", async (exitCode, signal) => {
    // Grandchildren may outlive the direct command. Keep the deadline supervising them.
    while (
      (processGroup && taskGroupMembers(processGroup).length > 0) ||
      (trackDescendants && liveDescendants().length > 0)
    ) {
      recordDescendants();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    clearInterval(sampler);
    clearTimeout(deadline);
    clearTimeout(killTimer);
    if (output !== null) fs.closeSync(output);
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
