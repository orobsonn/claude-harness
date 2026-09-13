import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import harnessTaskEvents from "./harness-task-events.ts";

const ENV = "PI_HARNESS_TUI_JOB_FILE";
const SESSION = "tui-session";

function install(jobFile) {
  const previous = process.env[ENV];
  if (jobFile === undefined) delete process.env[ENV];
  else process.env[ENV] = jobFile;
  const handlers = new Map();
  harnessTaskEvents(
    /** @type {any} */ ({
      on(name, handler) {
        handlers.set(name, handler);
      },
    }),
  );
  return {
    handlers,
    restore() {
      if (previous === undefined) delete process.env[ENV];
      else process.env[ENV] = previous;
    },
  };
}

function fixture(t, overrides = {}) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-events-")),
  );
  const jobDir = path.join(root, "job");
  fs.mkdirSync(jobDir);
  const jobFile = path.join(jobDir, "job.json");
  const eventsPath = path.join(jobDir, "events.jsonl");
  fs.writeFileSync(eventsPath, overrides.tail ?? "", { mode: 0o600 });
  const job = {
    version: 1,
    presentation: "tui",
    terminal_mode: true,
    cwd: root,
    events_path: eventsPath,
    ...overrides.job,
  };
  if (overrides.rawJob !== undefined)
    fs.writeFileSync(jobFile, overrides.rawJob, { mode: 0o600 });
  else fs.writeFileSync(jobFile, JSON.stringify(job), { mode: 0o600 });
  const extension = install(overrides.jobFile ?? jobFile);
  t.after(() => {
    extension.restore();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const notifications = [];
  const order = [];
  let shutdowns = 0;
  const header = {
    type: "session",
    version: 3,
    id: SESSION,
    timestamp: "2026-09-08T00:00:00.000Z",
    cwd: root,
  };
  const ctx = {
    cwd: root,
    mode: "tui",
    ui: { notify: (...args) => notifications.push(args) },
    sessionManager: {
      getSessionId: () => SESSION,
      getHeader: () => header,
    },
    shutdown() {
      shutdowns++;
      order.push("shutdown");
    },
  };
  return {
    root,
    jobDir,
    jobFile,
    eventsPath,
    handlers: extension.handlers,
    ctx,
    header,
    notifications,
    order,
    shutdowns: () => shutdowns,
    lines: () =>
      fs
        .readFileSync(eventsPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(JSON.parse),
  };
}

test("missing env and legacy non-TUI mode are inert", (t) => {
  const absent = install(undefined);
  t.after(() => absent.restore());
  assert.equal(absent.handlers.size, 0);

  const f = fixture(t, { rawJob: "not json" });
  const legacy = { ...f.ctx, mode: "json" };
  f.handlers.get("session_start")({}, legacy);
  f.handlers.get("tool_execution_start")(
    { type: "tool_execution_start", toolCallId: "legacy", toolName: "read", args: {} },
    legacy,
  );
  f.handlers.get("agent_end")({}, legacy);
  assert.equal(f.shutdowns(), 0);
  assert.deepEqual(f.notifications, []);
  assert.deepEqual(f.lines(), []);
});

test("native child session never opens evidence or requests shutdown", (t) => {
  const f = fixture(t, { rawJob: "not json", tail: '{"existing":true}\n' });
  const child = {
    ...f.ctx,
    sessionManager: {
      ...f.ctx.sessionManager,
      getHeader: () => ({ ...f.header, parentSession: "parent" }),
    },
  };
  f.handlers.get("session_start")({}, child);
  f.handlers.get("tool_execution_start")(
    { type: "tool_execution_start", toolCallId: "child", toolName: "read", args: { path: "x" } },
    child,
  );
  f.handlers.get("tool_execution_end")(
    { type: "tool_execution_end", toolCallId: "child", toolName: "read", result: "x", isError: false },
    child,
  );
  f.handlers.get("agent_end")({}, child);
  f.handlers.get("session_shutdown")({}, child);
  assert.equal(f.shutdowns(), 0);
  assert.deepEqual(f.notifications, []);
  assert.deepEqual(f.lines(), [{ existing: true }]);
});

test("records one native header and complete native tool events without losing an existing tail", (t) => {
  const f = fixture(t, { tail: '{"type":"existing-tail","n":1}\n' });
  const start = {
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "printf ok", nested: { exact: [1, true, null] } },
    futureNativeField: { retained: true },
  };
  const end = {
    type: "tool_execution_end",
    toolCallId: "call-1",
    toolName: "bash",
    result: { content: [{ type: "text", text: "ok" }], details: { code: 0 } },
    isError: false,
    futureNativeField: ["retained"],
  };

  f.handlers.get("session_start")({}, f.ctx);
  // A duplicate native start for the already-bound session cannot append a second
  // header or silently replace the first recorder.
  f.handlers.get("session_start")({}, f.ctx);
  f.handlers.get("tool_execution_start")(start, f.ctx);
  f.handlers.get("tool_execution_end")(end, f.ctx);
  f.ctx.shutdown = () => {
    assert.deepEqual(f.lines(), [
      { type: "existing-tail", n: 1 },
      f.header,
      start,
      end,
    ]);
    f.order.push("shutdown");
  };
  const nativeFsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    f.order.push("flush");
    return nativeFsync(fd);
  };
  try {
    f.handlers.get("agent_end")({}, f.ctx);
  } finally {
    fs.fsyncSync = nativeFsync;
  }
  assert.deepEqual(f.order, ["flush", "shutdown"]);

  f.handlers.get("session_shutdown")({}, f.ctx);
  const before = fs.readFileSync(f.eventsPath, "utf8");
  f.handlers.get("tool_execution_start")(
    { type: "tool_execution_start", toolCallId: "late", toolName: "read", args: {} },
    f.ctx,
  );
  assert.equal(fs.readFileSync(f.eventsPath, "utf8"), before);
});

test("job path, descriptor and events-file violations fail closed before tools proceed", (t) => {
  const cases = [
    {
      name: "relative job path",
      configure(f) {
        return "job.json";
      },
      reason: /job file must be absolute/,
    },
    {
      name: "job symlink",
      configure(f) {
        const link = path.join(f.root, "job-link.json");
        fs.symlinkSync(f.jobFile, link);
        return link;
      },
      reason: /regular non-symlink/,
    },
    {
      name: "job directory",
      configure(f) {
        return f.jobDir;
      },
      reason: /regular non-symlink/,
    },
    {
      name: "malformed job",
      job: { rawJob: "{" },
      reason: /JSON/,
    },
    {
      name: "wrong presentation",
      job: { job: { presentation: "json" } },
      reason: /presentation mismatch/,
    },
    {
      name: "wrong terminal mode",
      job: { job: { terminal_mode: false } },
      reason: /presentation mismatch/,
    },
    {
      name: "wrong cwd",
      job: { job: { cwd: os.tmpdir() } },
      reason: /cwd mismatch/,
    },
    {
      name: "wrong events path",
      job: { job: { events_path: "/tmp/elsewhere.jsonl" } },
      reason: /events path mismatch/,
    },
  ];

  for (const entry of cases) {
    const f = fixture(t, entry.job);
    if (entry.configure) {
      const replacement = install(entry.configure(f));
      t.after(() => replacement.restore());
      f.handlers = replacement.handlers;
    }
    const before = fs.readFileSync(f.eventsPath, "utf8");
    f.handlers.get("session_start")({}, f.ctx);
    assert.equal(f.shutdowns(), 1, entry.name);
    assert.match(f.notifications[0]?.[0] ?? "", entry.reason, entry.name);
    f.handlers.get("tool_execution_start")(
      { type: "tool_execution_start", toolCallId: "denied", toolName: "bash", args: {} },
      f.ctx,
    );
    assert.equal(fs.readFileSync(f.eventsPath, "utf8"), before, entry.name);
  }
});

test("symlink, non-regular and permissive events files are rejected", (t) => {
  for (const kind of ["symlink", "directory", "mode"]) {
    const f = fixture(t);
    fs.rmSync(f.eventsPath);
    if (kind === "symlink") {
      const target = path.join(f.root, "target.jsonl");
      fs.writeFileSync(target, "", { mode: 0o600 });
      fs.symlinkSync(target, f.eventsPath);
    } else if (kind === "directory") {
      fs.mkdirSync(f.eventsPath);
    } else {
      fs.writeFileSync(f.eventsPath, "", { mode: 0o644 });
      fs.chmodSync(f.eventsPath, 0o644);
    }
    f.handlers.get("session_start")({}, f.ctx);
    assert.equal(f.shutdowns(), 1, kind);
    assert.equal(f.notifications.length, 1, kind);
  }
});

test("a bound owner mismatch closes evidence and shuts down fail closed", (t) => {
  const f = fixture(t);
  f.handlers.get("session_start")({}, f.ctx);
  const before = fs.readFileSync(f.eventsPath, "utf8");
  const mismatch = {
    ...f.ctx,
    sessionManager: {
      ...f.ctx.sessionManager,
      getSessionId: () => "different-session",
    },
  };
  f.handlers.get("tool_execution_start")(
    { type: "tool_execution_start", toolCallId: "wrong", toolName: "read", args: {} },
    mismatch,
  );
  assert.equal(f.shutdowns(), 1);
  assert.match(f.notifications[0][0], /owner\/session\/cwd mismatch/);
  assert.equal(fs.readFileSync(f.eventsPath, "utf8"), before);
});

test("the first parent start requires matching native header and runtime session ids", (t) => {
  const f = fixture(t);
  const mismatch = {
    ...f.ctx,
    sessionManager: {
      ...f.ctx.sessionManager,
      getHeader: () => ({ ...f.header, id: "different-session" }),
    },
  };
  f.handlers.get("session_start")({}, mismatch);
  assert.equal(f.shutdowns(), 1);
  assert.match(f.notifications[0][0], /session header identity mismatch/);
  assert.deepEqual(f.lines(), []);
});


test("TUI persists the local assistant report before shutdown without private thinking or nested reports", (t) => {
  const f = fixture(t);
  f.handlers.get("session_start")({}, f.ctx);
  const message = { role: "assistant", stopReason: "stop", content: [
    { type: "thinking", thinking: "private", thinkingSignature: "secret" },
    { type: "text", text: "BLOCKED: recovery test conflicts with proposed fix." },
  ] };
  f.handlers.get("message_end")({ message }, f.ctx);
  assert.deepEqual(f.lines().at(-1), { type: "message_end", message: {
    role: "assistant", stopReason: "stop", content: [message.content[1]],
  } });
  const before = f.lines().length;
  f.handlers.get("message_end")({ message: { role: "user", content: [{ type: "text", text: "DONE" }] } }, f.ctx);
  assert.equal(f.lines().length, before);
  f.handlers.get("agent_end")({}, f.ctx);
  assert.equal(f.lines().at(-1).message.content[0].text, message.content[1].text);
});
