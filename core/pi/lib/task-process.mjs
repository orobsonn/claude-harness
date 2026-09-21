/** Durable lifecycle for isolated task parents; observation never launches work. */
import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MODEL_PROFILE_ENV,
  MODEL_PROFILE_HASH_ENV,
} from "./model-profile.mjs";

const TASK_WORKER_PATH = fileURLToPath(
  new URL("../bin/pi-task-worker.mjs", import.meta.url),
);

const HEX_256 = /^[0-9a-f]{64}$/;

/** Only immutable profile pointers cross an Orca terminal boundary; never secrets. */
export function validateTaskProfileEnvironment(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [MODEL_PROFILE_ENV, MODEL_PROFILE_HASH_ENV].sort().join("\0") ||
      typeof value[MODEL_PROFILE_ENV] !== "string" || !path.isAbsolute(value[MODEL_PROFILE_ENV]) ||
      typeof value[MODEL_PROFILE_HASH_ENV] !== "string" || !HEX_256.test(value[MODEL_PROFILE_HASH_ENV])) {
    throw new Error("task model profile environment is invalid");
  }
  return {
    [MODEL_PROFILE_ENV]: value[MODEL_PROFILE_ENV],
    [MODEL_PROFILE_HASH_ENV]: value[MODEL_PROFILE_HASH_ENV],
  };
}

export function writeTaskJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

export function taskProcessIdentity(pid) {
  try {
    if (process.platform === "linux") {
      const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
      return {
        pid: Number(pid),
        state: fields[0],
        group: Number(fields[2]),
        start: fields[19],
      };
    }
    const output = execFileSync(
      "ps",
      ["-p", String(pid), "-o", "pgid=,stat=,lstart="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const fields = output.split(/\s+/);
    return output
      ? {
          pid: Number(pid),
          group: Number(fields[0]),
          state: fields[1],
          start: fields.slice(2).join(" "),
        }
      : null;
  } catch {
    // An unreadable-but-existing PID is not evidence that the process ended.  Keep that
    // distinction so recovery cannot approve a launch merely because /proc raced or access
    // was denied.
    try {
      process.kill(Number(pid), 0);
      return { pid: Number(pid), unknown: true };
    } catch (error) {
      return error?.code === "EPERM"
        ? { pid: Number(pid), unknown: true }
        : null;
    }
  }
}

export function taskGroupMembers(group) {
  if (process.platform === "linux") {
    return fs
      .readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name))
      .map(taskProcessIdentity)
      .filter(
        (item) => item && item.group === group && !/^[ZX]/.test(item.state),
      );
  }
  const lines = execFileSync("ps", ["-axo", "pid=,pgid=,stat="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  return lines
    .map((line) => {
      const [pid, pgid, state] = line.trim().split(/\s+/);
      return { pid: Number(pid), group: Number(pgid), state };
    })
    .filter((item) => item.group === group && !/^[ZX]/.test(item.state));
}

function processCommand(pid) {
  try {
    if (process.platform === "linux")
      return fs
        .readFileSync(`/proc/${pid}/cmdline`)
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    const output = execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return output ? output.split(/\s+/) : [];
  } catch {
    return [];
  }
}

export function exactWorkerPids(launch) {
  if (
    typeof launch?.worker_path !== "string" ||
    typeof launch?.descriptor_path !== "string"
  )
    return [];
  // The supervisor and its independently grouped child shim both carry this exact
  // descriptor. Scan the process table even when the original supervisor PID is
  // known: the shim can survive a supervisor crash during group registration.
  const candidates = process.platform === "linux"
    ? fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name))
    : execFileSync("ps", ["-axo", "pid="], { encoding: "utf8" })
        .trim()
        .split(/\s+/);
  return candidates
    .filter((pid) => {
      const command = processCommand(pid);
      return (
        (command.length === 3 ||
          (command.length === 4 && command[2] === "--child")) &&
        path.resolve(command[1] ?? "") === path.resolve(launch.worker_path) &&
        path.resolve(command.at(-1) ?? "") ===
          path.resolve(launch.descriptor_path) &&
        /(?:^|[\\/])node(?:\.exe)?$/.test(command[0] ?? "")
      );
    })
    .map(Number);
}

/** Render only public assistant text and tool progress from Pi's JSON stream. */
export function renderTaskEventLine(line) {
  try {
    const event = JSON.parse(line);
    if (
      event?.type === "message_update" &&
      event.assistantMessageEvent?.type === "text_delta" &&
      typeof event.assistantMessageEvent.delta === "string"
    )
      return event.assistantMessageEvent.delta;
    if (
      event?.type === "tool_execution_start" &&
      typeof event.toolName === "string"
    )
      return `\n[tool] ${event.toolName}\n`;
    if (
      event?.type === "tool_execution_end" &&
      typeof event.toolName === "string"
    )
      return `[tool] ${event.toolName} ${event.isError ? "failed" : "done"}\n`;
  } catch {
    /* Unknown/non-JSON output is retained in the receipt file, never echoed. */
  }
  return "";
}

function validResult(result, record) {
  return (
    result &&
    typeof result === "object" &&
    !Array.isArray(result) &&
    result.version === 1 &&
    result.run_id === record.run_id &&
    result.pid === record.pid &&
    typeof result.timedOut === "boolean" &&
    (result.exitCode === null || Number.isInteger(result.exitCode)) &&
    (result.signal === null || typeof result.signal === "string") &&
    typeof result.ended_at === "string" &&
    result.ended_at
  );
}

/** Observe one launch; injected process readers make PID-reuse races deterministic in tests. */
export function readTaskProcess(launch, dependencies = {}) {
  const identity = dependencies.identityFn ?? taskProcessIdentity;
  const groupMembers = dependencies.groupMembersFn ?? taskGroupMembers;
  const workerPids = dependencies.workerPidsFn ?? exactWorkerPids;
  const readJson =
    dependencies.readJsonFn ??
    ((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const fail = (reason, terminal = false, extra = {}) => ({
    ok: false,
    running: !terminal,
    terminal,
    reason,
    ...extra,
  });
  const interrupted = (reason, extra = {}) =>
    fail(reason, true, { interrupted: true, ...extra });
  try {
    if (
      !launch ||
      typeof launch !== "object" ||
      typeof launch.run_id !== "string" ||
      !launch.run_id
    )
      return fail("task launch identity mismatch");
    let record;
    try {
      record = readJson(launch.process_path);
    } catch (error) {
      if (
        launch.start_failure?.written_by === "host-task-launch" &&
        typeof launch.start_failure.reason === "string" &&
        launch.start_failure.reason
      ) {
        return interrupted("task launch aborted before worker registration", {
          startFailure: launch.start_failure,
        });
      }
      let exactWorkers;
      try {
        exactWorkers = workerPids(launch);
      } catch {
        return fail("task worker process observation is unavailable");
      }
      if (Array.isArray(exactWorkers) && exactWorkers.length > 0)
        return { ok: true, running: true, terminal: false, registering: true };
      if (launch.terminal_mode)
        return fail(
          "orca task terminal has not registered its worker; terminal observation is required",
        );
      if (
        !Number.isInteger(launch.creator_pid) ||
        launch.creator_pid < 1 ||
        typeof launch.creator_start_ticks !== "string" ||
        !launch.creator_start_ticks
      ) {
        return fail(`task lifecycle unavailable: ${error.message}`);
      }
      let creator;
      try {
        creator = identity(launch.creator_pid);
      } catch {
        return fail("task launch creator identity is unavailable");
      }
      if (creator?.unknown)
        return fail("task launch creator identity is unavailable");
      if (
        creator &&
        creator.start === launch.creator_start_ticks &&
        !/^[ZX]/.test(creator.state)
      ) {
        return fail(
          "task worker has not registered while its launch creator is still active",
        );
      }
      if (creator && creator.start !== launch.creator_start_ticks)
        return interrupted(
          "task launch aborted-before-registration after creator PID reuse",
        );
      return interrupted(
        "task launch aborted-before-registration after creator exit",
      );
    }
    if (
      !record ||
      record.version !== 1 ||
      record.run_id !== launch.run_id ||
      !Number.isInteger(record.pid) ||
      record.pid < 1 ||
      (launch.pid != null && record.pid !== launch.pid) ||
      typeof record.process_start_ticks !== "string" ||
      !record.process_start_ticks
    ) {
      return fail("task process identity mismatch");
    }
    if (
      launch.runtime?.sha256 &&
      record.run_runtime_sha256 !== launch.runtime.sha256
    )
      return fail("task process runtime identity mismatch");
    let result = null;
    try {
      result = readJson(launch.result_path);
    } catch {
      /* classified after process observation */
    }
    let current;
    try {
      current = identity(record.pid);
    } catch {
      return fail("task worker identity observation is unavailable");
    }
    const reused = current && current.start !== record.process_start_ticks;
    const sameLiveWorker = current && !reused && !/^[ZX]/.test(current.state);
    if (sameLiveWorker)
      return {
        ok: true,
        running: true,
        terminal: false,
        record,
        ...(result ? { result } : {}),
      };
    if (
      result &&
      validResult(result, record) &&
      (!launch.runtime?.sha256 ||
        result.run_runtime_sha256 === launch.runtime.sha256)
    )
      return { ok: true, running: false, terminal: true, record, result };
    let groupReused = false;
    if (Number.isInteger(record.process_group)) {
      if (typeof record.child_process_start_ticks !== "string")
        return fail("task child process group identity is unavailable");
      let leader;
      try {
        leader = identity(record.process_group);
      } catch {
        return fail("task child process group identity is unavailable");
      }
      if (leader?.unknown)
        return fail("task child process group identity is unavailable");
      groupReused = Boolean(
        leader &&
          leader.start !== record.child_process_start_ticks &&
          leader.group === record.process_group,
      );
    }
    let members;
    try {
      members = Number.isInteger(record.process_group) && !groupReused
        ? groupMembers(record.process_group)
        : [];
    } catch {
      return fail("task worker group observation is unavailable");
    }
    if (members.length > 0)
      return {
        ok: true,
        running: true,
        terminal: false,
        record,
        ...(result ? { result } : {}),
      };
    if (!Number.isInteger(record.process_group)) {
      let exactWorkers;
      try {
        exactWorkers = workerPids(launch);
      } catch {
        return fail("task worker process observation is unavailable");
      }
      if (exactWorkers.length > 0)
        return { ok: true, running: true, terminal: false, record };
    }
    if (result)
      return fail("task completion identity mismatch", true, { record });
    return interrupted(
      reused
        ? "task worker ended before completion and its PID was reused"
        : "task process ended without a completion record",
      { record },
    );
  } catch (error) {
    return fail(
      `task lifecycle unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Called only by the host coordinator. Secrets are never serialized. */
export async function startTaskProcess({
  jobDir,
  runId,
  cwd,
  command,
  args,
  runtime,
  timeoutMs = 7_200_000,
  launchTerminal,
  title,
  presentation = "json",
  profileEnvironment,
}) {
  let launch;
  let worker;
  try {
    if (presentation !== "json" && presentation !== "tui")
      throw new Error(`unsupported task presentation: ${presentation}`);
    if (presentation === "tui" && !launchTerminal)
      throw new Error("tui task presentation requires a terminal launcher");
    fs.mkdirSync(jobDir, { recursive: true });
    const creator = taskProcessIdentity(process.pid);
    if (!creator?.start)
      throw new Error("task launch creator identity unavailable");
    const descriptor = path.join(jobDir, "job.json");
    launch = {
      run_id: runId,
      pid: null,
      creator_pid: process.pid,
      creator_start_ticks: creator.start,
      runtime,
      worker_path: TASK_WORKER_PATH,
      descriptor_path: descriptor,
      events_path: path.join(jobDir, "events.jsonl"),
      stderr_path: path.join(jobDir, "stderr.log"),
      process_path: path.join(jobDir, "process.json"),
      result_path: path.join(jobDir, "result.json"),
      ...(launchTerminal ? { terminal_mode: true } : {}),
      ...(presentation === "tui" ? { presentation } : {}),
    };
    const admittedProfileEnvironment = validateTaskProfileEnvironment(profileEnvironment);
    writeTaskJson(descriptor, {
      ...launch,
      cwd,
      command,
      args,
      runtime,
      timeoutMs,
      ...(admittedProfileEnvironment ? { profile_environment: admittedProfileEnvironment } : {}),
    });
    if (launchTerminal) {
      try {
        const terminal = await launchTerminal({
          command: process.execPath,
          args: [TASK_WORKER_PATH, descriptor],
          cwd,
          title,
        });
        return { ...launch, orca: terminal };
      } catch (error) {
        if (error && typeof error === "object") {
          error.outcome_unknown = true;
          error.task_launch = launch;
        }
        throw error;
      }
    }
    worker = spawn(process.execPath, [TASK_WORKER_PATH, descriptor], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    await new Promise((resolve, reject) => {
      worker.once("spawn", resolve);
      worker.once("error", (error) => {
        error.before_spawn = true;
        reject(error);
      });
    });
  } catch (error) {
    if (error && typeof error === "object" && !error.outcome_unknown)
      error.before_spawn = true;
    throw error;
  }
  launch.pid = worker.pid;
  worker.unref();
  const workerIdentity = taskProcessIdentity(worker.pid);
  if (workerIdentity && !fs.existsSync(launch.process_path))
    writeTaskJson(launch.process_path, {
      version: 1,
      run_id: runId,
      pid: worker.pid,
      process_start_ticks: workerIdentity.start,
      started_at: new Date().toISOString(),
      ...(runtime?.sha256 ? { run_runtime_sha256: runtime.sha256 } : {}),
    });
  return launch;
}
