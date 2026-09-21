import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  startTaskProcess,
  readTaskProcess,
  renderTaskEventLine,
  taskGroupMembers,
  taskProcessIdentity,
} from "./task-process.mjs";
import { MODEL_PROFILE_ENV, MODEL_PROFILE_HASH_ENV } from "./model-profile.mjs";

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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function realPtyLauncher(t, { input = "", beforeLaunch } = {}) {
  const state = { output: "", error: "", process: null, closed: null };
  t.after(() => {
    try { state.process?.kill("SIGKILL"); } catch {}
  });
  return {
    state,
    launch: async (request) => {
      beforeLaunch?.(request);
      const transcript = path.join(
        request.cwd,
        `pty-${Date.now()}-${Math.random().toString(16).slice(2)}.log`,
      );
      const command = [request.command, ...request.args]
        .map(shellQuote)
        .join(" ");
      const child = spawn("/usr/bin/script", ["-qefc", command, transcript], {
        cwd: request.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      state.process = child;
      child.stdout.on("data", (chunk) => { state.output += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk) => { state.error += chunk.toString("utf8"); });
      state.closed = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      await new Promise((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
      if (input) child.stdin.write(input);
      child.stdin.end();
      return {
        terminal_handle: "real-pty",
        worktree_id: "repo::/worktree",
        surface: "visible",
      };
    },
  };
}

test("task worker transports only immutable model profile pointers", async (t) => {
  const dir = fixture(t);
  const marker = path.join(dir, "profile-env.json");
  const profile = path.join(dir, "profile.json");
  const digest = "a".repeat(64);
  const launch = await startTaskProcess({
    jobDir: path.join(dir, "job"),
    runId: "profile-env",
    cwd: dir,
    command: process.execPath,
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({path:process.env.${MODEL_PROFILE_ENV},hash:process.env.${MODEL_PROFILE_HASH_ENV}}))`],
    profileEnvironment: {
      [MODEL_PROFILE_ENV]: profile,
      [MODEL_PROFILE_HASH_ENV]: digest,
    },
  });
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { path: profile, hash: digest });
  const descriptor = JSON.parse(fs.readFileSync(launch.descriptor_path, "utf8"));
  assert.deepEqual(descriptor.profile_environment, {
    [MODEL_PROFILE_ENV]: profile,
    [MODEL_PROFILE_HASH_ENV]: digest,
  });
  await assert.rejects(startTaskProcess({
    jobDir: path.join(dir, "bad-job"),
    runId: "bad-profile-env",
    cwd: dir,
    command: process.execPath,
    args: ["-e", ""],
    profileEnvironment: {
      [MODEL_PROFILE_ENV]: profile,
      [MODEL_PROFILE_HASH_ENV]: digest,
      TYPESAFE_API_KEY: "must-not-be-serialized",
    },
  }), /profile environment is invalid/);
});
test("detached worker persists identity, output and completion across coordinator instances", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "run-1",
    cwd: dir,
    command: process.execPath,
    args: ["-e", 'const timer=setInterval(()=>{if(require("node:fs").existsSync("release-child")){clearInterval(timer);console.log("done")}},20)'],
    timeoutMs: 10000,
  });
  let finished = false;
  t.after(() => { if (!finished) { try { process.kill(launch.pid, "SIGTERM"); } catch {} } });
  assert.equal(
    readTaskProcess(JSON.parse(JSON.stringify(launch))).running,
    true,
  );
  fs.writeFileSync(path.join(dir, "release-child"), "release\n");
  const end = await terminal(launch);
  finished = true;
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

test("terminal hangup stops the detached task group instead of leaving a paid run orphaned", async (t) => {
  const dir = fixture(t);
  const launch = await startTaskProcess({ jobDir: dir, runId: "hangup", cwd: dir, command: process.execPath,
    args: ["-e", 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'] });
  let group;
  t.after(() => {
    for (const member of Number.isInteger(group) ? taskGroupMembers(group) : []) {
      try { process.kill(member.pid, "SIGKILL"); } catch {}
    }
    try { process.kill(launch.pid, "SIGKILL"); } catch {}
  });
  for (let i = 0; i < 150; i++) {
    try {
      group = JSON.parse(fs.readFileSync(launch.process_path, "utf8")).process_group;
      if (Number.isInteger(group) && fs.readFileSync(launch.events_path, "utf8").includes("ready")) break;
    } catch {}
    await pause(20);
  }
  assert.ok(Number.isInteger(group));
  process.kill(launch.pid, "SIGHUP");
  const ended = await terminal(launch);
  assert.equal(ended.terminal, true);
  assert.equal(ended.running, false);
  assert.equal(taskGroupMembers(group).filter((member) => member.state !== "Z").length, 0);
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
      assert.equal(descriptor.presentation, undefined);
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

test("tui presentation inherits a real PTY, exposes its private descriptor and tees stderr", {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/script"),
}, async (t) => {
  const dir = fixture(t);
  const pty = realPtyLauncher(t, {
    input: "from-terminal\n",
    beforeLaunch: (request) => {
      const descriptor = request.args.at(-1);
      const job = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      job.descriptor_path = path.join(dir, "forged-job.json");
      fs.writeFileSync(descriptor, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    },
  });
  const program = [
    'const fs = require("node:fs")',
    'const readline = require("node:readline")',
    'const descriptor = process.env.PI_HARNESS_TUI_JOB_FILE',
    'const job = JSON.parse(fs.readFileSync(descriptor, "utf8"))',
    'fs.appendFileSync(job.events_path, JSON.stringify({source:"event-sink", descriptor}) + "\\n")',
    'console.log(`TUI tty=${process.stdin.isTTY}/${process.stdout.isTTY}`)',
    'console.log(JSON.stringify({type:"tool_execution_start",toolName:"bash"}))',
    'console.error("private-stderr")',
    'const rl = readline.createInterface({input: process.stdin})',
    'rl.once("line", line => { console.log(`input=${line}`); rl.close() })',
  ].join(";");
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "tui-real-pty",
    cwd: dir,
    command: process.execPath,
    args: ["-e", program],
    presentation: "tui",
    launchTerminal: pty.launch,
  });
  assert.equal(launch.presentation, "tui");
  assert.equal(launch.terminal_mode, true);
  const descriptor = JSON.parse(fs.readFileSync(launch.descriptor_path, "utf8"));
  assert.equal(descriptor.presentation, "tui");

  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(end.result.exitCode, 0);
  assert.deepEqual(await pty.state.closed, { code: 0, signal: null });
  assert.match(pty.state.output, /TUI tty=true\/true/);
  assert.match(pty.state.output, /input=from-terminal/);
  assert.match(pty.state.output, /"type":"tool_execution_start"/);
  assert.doesNotMatch(pty.state.output, /\[tool\] bash/);
  assert.match(pty.state.output, /private-stderr/);
  assert.equal(fs.readFileSync(launch.stderr_path, "utf8"), "private-stderr\n");
  const event = JSON.parse(fs.readFileSync(launch.events_path, "utf8"));
  assert.deepEqual(event, {
    source: "event-sink",
    descriptor: launch.descriptor_path,
  });
  assert.equal(fs.statSync(launch.events_path).mode & 0o777, 0o600);
});

test("tui timeout terminates the PTY child group and writes a terminal result", {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/script"),
}, async (t) => {
  const dir = fixture(t);
  const pty = realPtyLauncher(t);
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "tui-timeout",
    cwd: dir,
    command: process.execPath,
    args: ["-e", 'setInterval(()=>{},30000)'],
    timeoutMs: 100,
    presentation: "tui",
    launchTerminal: pty.launch,
  });
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(end.result.timedOut, true);
  assert.notEqual(end.result.exitCode, 0);
  await pty.state.closed;
  // A valid short timeout may precede the child program's first output under load.
  // PTY inheritance is asserted by the successful interactive case above.
  assert.deepEqual(taskGroupMembers(end.record.process_group), []);
});

test("tui worker does not follow an events symlink before the recorder opens it", {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/script"),
}, async (t) => {
  const dir = fixture(t);
  const target = path.join(dir, "outside-events");
  fs.writeFileSync(target, "sentinel\n");
  const pty = realPtyLauncher(t, {
    beforeLaunch: (request) => {
      const job = JSON.parse(fs.readFileSync(request.args.at(-1), "utf8"));
      fs.symlinkSync(target, job.events_path);
    },
  });
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "tui-events-symlink",
    cwd: dir,
    command: process.execPath,
    args: ["-e", 'require("node:fs").appendFileSync("child-ran", "yes")'],
    presentation: "tui",
    launchTerminal: pty.launch,
  });
  const end = await terminal(launch);
  await pty.state.closed;
  assert.equal(end.terminal, true);
  assert.equal(end.interrupted, true);
  assert.equal(fs.readFileSync(target, "utf8"), "sentinel\n");
  assert.equal(fs.existsSync(path.join(dir, "child-ran")), false);
  assert.equal(fs.existsSync(launch.result_path), false);
});

test("tui worker confines its event sink to the descriptor directory", {
  skip: process.platform !== "linux" || !fs.existsSync("/usr/bin/script"),
}, async (t) => {
  const dir = fixture(t);
  const outside = path.join(dir, "outside.jsonl");
  const pty = realPtyLauncher(t, {
    beforeLaunch: (request) => {
      const descriptor = request.args.at(-1);
      const job = JSON.parse(fs.readFileSync(descriptor, "utf8"));
      job.events_path = outside;
      fs.writeFileSync(descriptor, `${JSON.stringify(job)}\n`, { mode: 0o600 });
    },
  });
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "tui-events-outside",
    cwd: dir,
    command: process.execPath,
    args: ["-e", 'require("node:fs").appendFileSync("child-ran", "yes")'],
    presentation: "tui",
    launchTerminal: pty.launch,
  });
  const end = await terminal(launch);
  await pty.state.closed;
  assert.equal(end.terminal, true);
  assert.equal(end.interrupted, true);
  assert.equal(fs.existsSync(outside), false);
  assert.equal(fs.existsSync(path.join(dir, "child-ran")), false);
});

test("tui presentation is explicit and requires a terminal launcher", async (t) => {
  const dir = fixture(t);
  await assert.rejects(
    startTaskProcess({
      jobDir: dir,
      runId: "tui-without-terminal",
      cwd: dir,
      command: process.execPath,
      args: ["-e", ""],
      presentation: "tui",
    }),
    (error) => error?.before_spawn === true && /requires a terminal launcher/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(dir, "job.json")), false);
  await assert.rejects(
    startTaskProcess({
      jobDir: dir,
      runId: "unknown-presentation",
      cwd: dir,
      command: process.execPath,
      args: ["-e", ""],
      presentation: "html",
    }),
    /unsupported task presentation/,
  );
});

test("legacy json workers remove an inherited tui descriptor", async (t) => {
  const dir = fixture(t);
  const previous = process.env.PI_HARNESS_TUI_JOB_FILE;
  process.env.PI_HARNESS_TUI_JOB_FILE = "/foreign/job.json";
  t.after(() => {
    if (previous === undefined) delete process.env.PI_HARNESS_TUI_JOB_FILE;
    else process.env.PI_HARNESS_TUI_JOB_FILE = previous;
  });
  const launch = await startTaskProcess({
    jobDir: dir,
    runId: "legacy-clears-tui",
    cwd: dir,
    command: process.execPath,
    args: ["-e", 'console.log(process.env.PI_HARNESS_TUI_JOB_FILE ?? "cleared")'],
  });
  const end = await terminal(launch);
  assert.equal(end.ok, true);
  assert.equal(end.result.exitCode, 0);
  assert.equal(fs.readFileSync(launch.events_path, "utf8"), "cleared\n");
  const descriptor = JSON.parse(fs.readFileSync(launch.descriptor_path, "utf8"));
  assert.equal(descriptor.presentation, undefined);
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
    args: ["-e", "setTimeout(()=>{},10000)"],
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
