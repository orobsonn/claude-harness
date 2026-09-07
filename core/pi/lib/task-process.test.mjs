import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  startTaskProcess,
  readTaskProcess,
  renderTaskEventLine,
  taskGroupMembers,
  taskProcessIdentity,
} from "./task-process.mjs";

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function terminal(launch) {
  for (let i = 0; i < 150; i++) {
    const state = readTaskProcess(launch);
    if (state.terminal) return state;
    await pause(20);
  }
  throw new Error("worker did not terminate");
}
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-worker-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("detached worker persists identity, output and completion across coordinator instances", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "run-1",
    cwd: dir,
    command: process.execPath,
    args: ["-e", 'setTimeout(()=>console.log("done"),200)'],
  });
  assert.equal(
    readTaskProcess(JSON.parse(JSON.stringify(launch))).running,
    true,
  );
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(end.result.exitCode, 0);
  assert.match(fs.readFileSync(launch.events_path, "utf8"), /done/);
  const record = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
  assert.ok(Number.isInteger(record.process_group));
  assert.notEqual(record.process_group, record.pid);
  record.run_id = "foreign-launch";
  fs.writeFileSync(launch.process_path, JSON.stringify(record));
  assert.equal(readTaskProcess(launch).ok, false);
});

test("terminal launch persists its descriptor first and returns Orca identity", async (t) => {
  const dir = fixture(t);
  let request;
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "orca-terminal",
    cwd: dir,
    command: process.execPath,
    args: ["-e", ""],
    title: "task a",
    launchTerminal: async (value) => {
      request = value;
      const descriptor = JSON.parse(
        fs.readFileSync(value.args.at(-1), "utf8"),
      );
      assert.equal(descriptor.run_id, "orca-terminal");
      assert.equal(descriptor.terminal_mode, true);
      return {
        terminal_handle: "term_1",
        worktree_id: "repo::/worktree",
        surface: "visible",
        tab_id: "tab_1",
      };
    },
  });
  assert.equal(request.command, process.execPath);
  assert.equal(request.cwd, dir);
  assert.equal(request.title, "task a");
  assert.deepEqual(launch.orca, {
    terminal_handle: "term_1",
    worktree_id: "repo::/worktree",
    surface: "visible",
    tab_id: "tab_1",
  });
  assert.equal(launch.pid, null);
});

test("uncertain terminal launch failures preserve the observable identity", async (t) => {
  const dir = fixture(t);
  let failure;
  try {
    await startTaskProcess({
      jobDir: dir,
      runId: "orca-unknown",
      cwd: dir,
      command: process.execPath,
      args: ["-e", ""],
      launchTerminal: async () => {
        throw new Error("reply lost");
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.outcome_unknown, true);
  assert.equal(failure?.before_spawn, undefined);
  assert.equal(failure?.task_launch?.run_id, "orca-unknown");
  assert.equal(fs.existsSync(failure.task_launch.descriptor_path), true);
  const state = readTaskProcess(failure.task_launch, {
    workerPidsFn: () => [],
    identityFn: () => null,
  });
  assert.equal(state.running, true);
  assert.equal(state.terminal, false);
  assert.match(state.reason, /terminal observation is required/);
});

test("terminal renderer omits thinking, arguments and tool results", () => {
  assert.equal(
    renderTaskEventLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "public" },
    })),
    "public",
  );
  assert.equal(
    renderTaskEventLine(JSON.stringify({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", delta: "secret thought" },
    })),
    "",
  );
  assert.equal(
    renderTaskEventLine(JSON.stringify({
      type: "tool_execution_start",
      toolName: "bash",
      args: { command: "secret argument" },
    })),
    "\n[tool] bash\n",
  );
  assert.equal(
    renderTaskEventLine(JSON.stringify({
      type: "tool_execution_end",
      toolName: "bash",
      result: "secret result",
      isError: false,
    })),
    "[tool] bash done\n",
  );
  assert.equal(renderTaskEventLine("not json"), "");
});
test("timeout is terminal failure, and does not convert a still-running process into a valid return", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "run-timeout",
    cwd: dir,
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},30000)"],
    timeoutMs: 100,
  });
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(end.result.timedOut, true);
  assert.notEqual(end.result.exitCode, 0);
});
test("leftover descendants keep the group running after the command exits", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "descendant",
    cwd: dir,
    command: process.execPath,
    args: [
      "-e",
      `require('node:child_process').spawn(process.execPath,['-e','setTimeout(()=>{},500)'],{stdio:'ignore'}).unref()`,
    ],
  });
  await pause(180);
  assert.equal(readTaskProcess(launch).running, true);
  assert.equal((await terminal(launch)).result.exitCode, 0);
});

test("the exact child shim survives a supervisor crash during registration", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "child-shim",
    cwd: dir,
    command: process.execPath,
    args: ["-e", "setTimeout(()=>{},2000)"],
  });
  let record;
  for (let index = 0; index < 50; index++) {
    record = JSON.parse(fs.readFileSync(launch.process_path, "utf8"));
    if (record.process_group) break;
    await pause(10);
  }
  assert.ok(record.process_group);
  t.after(() => {
    for (const member of taskGroupMembers(record.process_group)) {
      try { process.kill(member.pid, "SIGKILL"); } catch {}
    }
  });
  process.kill(record.pid, "SIGKILL");
  for (let index = 0; index < 50; index++) {
    if (!taskProcessIdentity(record.pid)) break;
    await pause(10);
  }
  assert.equal(taskProcessIdentity(record.pid), null);
  fs.unlinkSync(launch.process_path);
  const registering = readTaskProcess(launch);
  assert.equal(registering.running, true);
  assert.equal(registering.registering, true);
  for (const member of taskGroupMembers(record.process_group)) {
    try { process.kill(member.pid, "SIGKILL"); } catch {}
  }
});

test("worker PID reuse does not hide the independent child group", (t) => {
  const dir = fixture(t);
  const launch = {
    run_id: "independent-group",
    pid: 123,
    worker_path: "/runtime/pi-task-worker.mjs",
    descriptor_path: path.join(dir, "job.json"),
    process_path: path.join(dir, "process.json"),
    result_path: path.join(dir, "result.json"),
  };
  fs.writeFileSync(launch.process_path, JSON.stringify({
    version: 1,
    run_id: launch.run_id,
    pid: 123,
    process_start_ticks: "worker-old",
    process_group: 456,
    child_process_start_ticks: "child-old",
  }));
  const observedGroups = [];
  const state = readTaskProcess(launch, {
    identityFn: (pid) => pid === 123
      ? { pid, start: "worker-new", state: "S", group: 999 }
      : { pid, start: "child-old", state: "S", group: 456 },
    groupMembersFn: (group) => {
      observedGroups.push(group);
      return [{ pid: 457, group, state: "S" }];
    },
  });
  assert.equal(state.running, true);
  assert.deepEqual(observedGroups, [456]);
});

test("a reused child group leader is never mistaken for this run", (t) => {
  const dir = fixture(t);
  const launch = {
    run_id: "reused-group",
    pid: 123,
    process_path: path.join(dir, "process.json"),
    result_path: path.join(dir, "result.json"),
  };
  fs.writeFileSync(launch.process_path, JSON.stringify({
    version: 1,
    run_id: launch.run_id,
    pid: 123,
    process_start_ticks: "worker-old",
    process_group: 456,
    child_process_start_ticks: "child-old",
  }));
  const state = readTaskProcess(launch, {
    identityFn: (pid) => pid === 123
      ? null
      : { pid, start: "unrelated-new", state: "S", group: 456 },
    groupMembersFn: () => {
      throw new Error("must not inspect a reused process group");
    },
  });
  assert.equal(state.terminal, true);
  assert.equal(state.interrupted, true);
});
test("unknown lifecycle fails closed and a missing result after death permits repair but not acceptance", (t) => {
  const dir = fixture(t);
  const launch = {
    run_id: "gone",
    pid: 999999999,
    creator_pid: 999999998,
    creator_start_ticks: "1",
    worker_path: "/tmp/pi-task-worker.mjs",
    descriptor_path: path.join(dir, "job.json"),
    process_path: path.join(dir, "process.json"),
    result_path: path.join(dir, "result.json"),
  };
  assert.equal(
    readTaskProcess({ ...launch, pid: null, creator_pid: null }).terminal,
    false,
  );
  assert.equal(readTaskProcess(launch).terminal, true);
  fs.writeFileSync(
    launch.process_path,
    JSON.stringify({
      version: 1,
      run_id: "gone",
      pid: 999999999,
      process_start_ticks: "1",
    }),
  );
  const state = readTaskProcess(launch);
  assert.equal(state.terminal, true);
  assert.equal(state.ok, false);
});

test("pre-registration observation distinguishes exact worker, live creator, dead creator and durable start failure", (t) => {
  const dir = fixture(t);
  const launch = {
    run_id: "registration",
    pid: null,
    creator_pid: 77,
    creator_start_ticks: "creator-start",
    worker_path: "/runtime/pi-task-worker.mjs",
    descriptor_path: path.join(dir, "job.json"),
    process_path: path.join(dir, "process.json"),
    result_path: path.join(dir, "result.json"),
  };
  const liveCreator = readTaskProcess(launch, {
    workerPidsFn: () => [],
    identityFn: () => ({ pid: 77, start: "creator-start", state: "S" }),
  });
  assert.equal(liveCreator.terminal, false);
  assert.equal(liveCreator.running, true);
  const unknownCreator = readTaskProcess(launch, {
    workerPidsFn: () => [],
    identityFn: () => ({ pid: 77, unknown: true }),
  });
  assert.equal(unknownCreator.terminal, false);
  assert.match(unknownCreator.reason, /identity is unavailable/);
  const stoppedWorker = readTaskProcess(launch, {
    workerPidsFn: () => [88],
    identityFn: () => null,
  });
  assert.deepEqual(
    {
      ok: stoppedWorker.ok,
      running: stoppedWorker.running,
      terminal: stoppedWorker.terminal,
      registering: stoppedWorker.registering,
    },
    { ok: true, running: true, terminal: false, registering: true },
  );
  const deadCreator = readTaskProcess(launch, {
    workerPidsFn: () => [],
    identityFn: () => null,
  });
  assert.equal(deadCreator.terminal, true);
  assert.equal(deadCreator.interrupted, true);
  assert.match(deadCreator.reason, /aborted-before-registration/);
  const startFailure = readTaskProcess(
    {
      ...launch,
      start_failure: {
        written_by: "host-task-launch",
        reason: "spawn ENOENT",
        at: "now",
      },
    },
    {
      workerPidsFn: () => {
        throw new Error("must not inspect");
      },
    },
  );
  assert.equal(startFailure.terminal, true);
  assert.equal(startFailure.interrupted, true);
});

test("a valid result defeats PID reuse but never declares the same live worker terminal", (t) => {
  const dir = fixture(t);
  const launch = {
    run_id: "pid-reuse",
    pid: 123,
    process_path: path.join(dir, "process.json"),
    result_path: path.join(dir, "result.json"),
  };
  fs.writeFileSync(
    launch.process_path,
    JSON.stringify({
      version: 1,
      run_id: launch.run_id,
      pid: 123,
      process_start_ticks: "old",
    }),
  );
  fs.writeFileSync(
    launch.result_path,
    JSON.stringify({
      version: 1,
      run_id: launch.run_id,
      pid: 123,
      exitCode: 0,
      signal: null,
      timedOut: false,
      ended_at: "now",
    }),
  );
  const reused = readTaskProcess(launch, {
    identityFn: () => ({ pid: 123, start: "new", state: "S" }),
    groupMembersFn: () => [{ pid: 123, group: 123, state: "S" }],
  });
  assert.equal(reused.ok, true);
  assert.equal(reused.terminal, true);
  const same = readTaskProcess(launch, {
    identityFn: () => ({ pid: 123, start: "old", state: "S" }),
    groupMembersFn: () => [],
  });
  assert.equal(same.running, true);
  assert.equal(same.terminal, false);
});

test("spawn failure before worker registration is identified for durable coordinator recovery", async (t) => {
  const dir = fixture(t);
  const missing = path.join(dir, "missing-cwd");
  await assert.rejects(
    startTaskProcess({
      jobDir: path.join(dir, "job"),
      runId: "before-spawn",
      cwd: missing,
      command: process.execPath,
      args: ["-e", ""],
    }),
    (error) => error?.before_spawn === true,
  );
  const parentFile = path.join(dir, "not-a-directory");
  fs.writeFileSync(parentFile, "occupied");
  await assert.rejects(
    startTaskProcess({
      jobDir: path.join(parentFile, "job"),
      runId: "preflight",
      cwd: dir,
      command: process.execPath,
      args: ["-e", ""],
    }),
    (error) => error?.before_spawn === true,
  );
});

test("worker refuses a changed runtime before launching the child and records only a generic error", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "runtime-drift",
    cwd: dir,
    command: process.execPath,
    args: ["-e", 'require("node:fs").writeFileSync("child-ran","")'],
    runtime: { launcher_path: process.execPath, sha256: "a".repeat(64) },
  });
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(end.result.exitCode, 1);
  assert.equal(end.result.error, "task runtime verification failed");
  assert.equal(end.result.run_runtime_sha256, "a".repeat(64));
  assert.equal(fs.existsSync(path.join(dir, "child-ran")), false);
  assert.equal(
    fs.readFileSync(launch.stderr_path, "utf8"),
    "task runtime verification failed\n",
  );
});
