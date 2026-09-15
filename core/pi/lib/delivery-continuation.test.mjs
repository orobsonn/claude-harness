import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installDeliveryContinuation, readDeliveryContinuation } from "./delivery-continuation.mjs";

function controller(options = {}) {
  const handlers = new Map(), entries = [], messages = [], notifications = [];
  let pending = { sessionId: "parent", stage: "task-reviews", key: "capture-a", content: "finish reviews" };
  const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getHeader: () => ({ id: "parent" }), getBranch: () => entries },
    ui: { notify: (...args) => notifications.push(args) } };
  const pi = { on: (name, handler) => handlers.set(name, handler),
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
    sendMessage: async (message, delivery) => { messages.push({ message, delivery }); } };
  const create = () => installDeliveryContinuation(pi, { readPending: () => pending, local: true, ...options });
  return { ctx, pi, handlers, entries, messages, notifications, create, end: create(), set: value => pending = value };
}
const stopped = { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Captured; review pending." }] }] };

test("captured task continues in the same turn queue; unchanged state cannot loop even after reload", async () => {
  const f = controller();
  assert.equal(await f.end(stopped, f.ctx), true);
  assert.deepEqual(f.messages[0].delivery, { deliverAs: "followUp", triggerTurn: true });
  assert.equal(await f.end(stopped, f.ctx), false);
  const reloaded = f.create();
  assert.equal(await reloaded(stopped, f.ctx), false);
  assert.equal(f.messages.length, 1);
  f.set({ sessionId: "parent", stage: "task-reviews", key: "capture-b", content: "finish affected review" });
  assert.equal(await reloaded(stopped, f.ctx), true);
  f.set(null);
  assert.equal(await reloaded(stopped, f.ctx), false, "ready task can terminate");
});

test("ordinary tools cannot arm a new workflow; a native task result can", async () => {
  const f = controller({ local: false });
  assert.equal(await f.end(stopped, f.ctx), false);
  f.handlers.get("tool_result")({ toolName: "bash", details: { ok: true } }, f.ctx);
  assert.equal(await f.end(stopped, f.ctx), false);
  f.handlers.get("tool_result")({ toolName: "harness_tasks", details: { ok: true, tasks: [{ status: "running" }] } }, f.ctx);
  assert.equal(await f.end(stopped, f.ctx), true);
});

test("abort, provider error, explicit pause and nested agents do not trigger continuation", async () => {
  for (const stopReason of ["aborted", "error"]) {
    const f = controller();
    assert.equal(await f.end({ messages: [{ role: "assistant", stopReason }] }, f.ctx), false);
  }
  for (const source of ["interactive", "rpc"]) {
    const f = controller();
    f.handlers.get("input")({ source, text: "pare agora" }, f.ctx);
    f.handlers.get("tool_result")({ toolName: "harness_tasks", details: { ok: true, tasks: [{ status: "running" }] } }, f.ctx);
    assert.equal(await f.end(stopped, f.ctx), false);
    assert.equal(await f.create()(stopped, f.ctx), false, "pause survives restart");
  }
  const f = controller();
  f.ctx.sessionManager.getHeader = () => ({ id: "child", parentSession: "parent" });
  assert.equal(await f.end(stopped, f.ctx), false);
  assert.equal(f.messages.length, 0);
});

test("failed queue delivery never claims continuation; no state or receipt is forged", async () => {
  const f = controller();
  f.pi.sendMessage = async () => { throw new Error("queue unavailable"); };
  assert.equal(await f.end(stopped, f.ctx), false);
  assert.equal(f.entries.length, 0);
  assert.match(f.notifications[0][0], /queue unavailable/);
});

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-continuation-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "baseline");
  const head = git("rev-parse", "HEAD");
  const directory = path.join(root, ".pi/harness/state/parent");
  const write = (file, value) => { const p = path.join(directory, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value)); };
  const state = { session_id: "parent", feature_id: "issue-22", mode: "FULL" };
  const registry = { parent_session_id: "parent", feature_id: "issue-22", tasks: { one: { task_id: "one", status: "running" } } };
  write("gate-state.json", state); write("task-runs/index.json", registry);
  const ctx = { cwd: root, sessionManager: { getSessionId: () => "parent", getHeader: () => ({ id: "parent" }) } };
  return { ctx, write, state, registry, head, directory };
}

test("real run states move from waiting to final review to shipping, but stop at verified shipment", t => {
  const f = fixture(t);
  assert.equal(readDeliveryContinuation(f.ctx).stage, "tasks");
  f.registry.tasks.one.status = "integrated";
  f.write("task-runs/index.json", f.registry);
  const before = readDeliveryContinuation(f.ctx);
  assert.equal(before.stage, "final-review");
  f.write("evidence/build.json", { head_sha: f.head, command: "npm run build", worktree_dirty: false, original_status: { exit_code: 0 } });
  const verified = readDeliveryContinuation(f.ctx);
  assert.notEqual(verified.key, before.key, "current command is real progress");
  f.write("evidence/build-again.json", { head_sha: f.head, command: "npm run build", worktree_dirty: false, original_status: { exit_code: 0 } });
  assert.equal(readDeliveryContinuation(f.ctx).key, verified.key, "repeating same check cannot renew loop");
  f.state.final_review_done = true; f.write("gate-state.json", f.state);
  assert.equal(readDeliveryContinuation(f.ctx).stage, "shipping");
  f.write("memory-shipment.json", { written_by: "host-subagent-completion", session_id: "parent", feature_id: "issue-22", head: "wrong", status: "completed" });
  assert.equal(readDeliveryContinuation(f.ctx).stage, "shipping", "stale shipment is not completion");
  f.write("memory-shipment.json", { written_by: "host-subagent-completion", session_id: "parent", feature_id: "issue-22", head: f.head, status: "completed" });
  assert.equal(readDeliveryContinuation(f.ctx), null, "draft delivery does not auto-merge");
});

test("unknown/mismatched authority and corrupted state never auto-start work", t => {
  const f = fixture(t);
  f.write("gate-state.json", { ...f.state, session_id: "other" });
  assert.equal(readDeliveryContinuation(f.ctx), null);
  f.write("gate-state.json", { ...f.state, mode: "QUICK" });
  assert.equal(readDeliveryContinuation(f.ctx), null);
  f.write("gate-state.json", { ...f.state, task_run: { task_id: "one" } });
  assert.equal(readDeliveryContinuation(f.ctx), null, "invalid local binding must not trigger a writer");
  fs.writeFileSync(path.join(f.directory, "gate-state.json"), "broken");
  assert.equal(readDeliveryContinuation(f.ctx), null);
});

test("task capture without re-gate continues locally, while ready and LIGHT completion can return", t => {
  const f = fixture(t);
  f.state.task_run = { task_id: "one" };
  const dependencies = { readBinding: () => ({ ok: true, grant: { task_id: "one" } }) };
  f.write("gate-state.json", f.state);
  assert.equal(readDeliveryContinuation(f.ctx, dependencies).stage, "task-implementation");
  f.state.capture_verified = [`issue-22/one@${f.head}`];
  f.write("gate-state.json", f.state);
  assert.equal(readDeliveryContinuation(f.ctx, dependencies).stage, "task-implementation", "test freeze alone is not implementation");
  f.state.hand_finished = ["issue-22/one"];
  f.write("gate-state.json", f.state);
  assert.equal(readDeliveryContinuation(f.ctx, dependencies).stage, "task-reviews");
  f.state.regate_passed = [`issue-22/one@${f.head}`];
  f.write("gate-state.json", f.state);
  assert.equal(readDeliveryContinuation(f.ctx, dependencies), null);
  f.state.mode = "LIGHT"; delete f.state.regate_passed;
  f.write("gate-state.json", f.state);
  assert.equal(readDeliveryContinuation(f.ctx, dependencies), null, "do not invent reviews in LIGHT");
});

test("uncommitted task RED is progress once, including restart, not a new approval", async t => {
  const f = fixture(t);
  f.state.task_run = { task_id: "one" }; f.write("gate-state.json", f.state);
  const dependencies = { readBinding: () => ({ ok: true, grant: { task_id: "one" },
    task: { scope_paths: ["src"], locked_tests: [{ path: "tests/one.spec.ts" }] } }) };
  const pending = () => readDeliveryContinuation(f.ctx, dependencies);
  const c = controller({ readPending: pending });
  assert.equal(await c.end(stopped, c.ctx), true);
  const before = pending();
  const file = path.join(f.ctx.cwd, "tests/one.spec.ts");
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, "new RED assertion\n");
  const after = pending();
  assert.notEqual(after.key, before.key, "new test bytes must renew the pending obligation without a commit");
  assert.equal(await c.end(stopped, c.ctx), true);
  assert.equal(await c.create()(stopped, c.ctx), false, "same dirty content cannot loop after reload");
  fs.writeFileSync(file, "new RED assertion\n");
  assert.equal(pending().key, after.key, "rewriting identical bytes is not progress");
  execFileSync("git", ["add", "--", "tests/one.spec.ts"], { cwd: f.ctx.cwd });
  assert.equal(pending().key, after.key, "staging alone is not another implementation step");
  fs.writeFileSync(path.join(f.ctx.cwd, "outside.txt"), "unrelated\n");
  f.write("evidence/noise.json", { timestamp: Date.now() });
  assert.equal(pending().key, after.key, "unrelated files and runtime churn do not renew continuation");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, "gate-state.json"))), f.state);
});

test("dirty task content prevents stale ready return; symlinks do not read outside the worktree", t => {
  const f = fixture(t), key = `issue-22/one@${f.head}`;
  Object.assign(f.state, { task_run: { task_id: "one" }, hand_finished: ["issue-22/one"],
    capture_verified: [key], regate_passed: [key] });
  f.write("gate-state.json", f.state);
  const dependencies = { readBinding: () => ({ ok: true, grant: { task_id: "one" },
    task: { scope_paths: ["src"] } }) };
  assert.equal(readDeliveryContinuation(f.ctx, dependencies), null);
  fs.mkdirSync(path.join(f.ctx.cwd, "src"));
  fs.writeFileSync(path.join(f.ctx.cwd, "src/product.ts"), "pending correction\n");
  assert.equal(readDeliveryContinuation(f.ctx, dependencies).stage, "task-implementation");
  const secret = path.join(f.ctx.cwd, "outside.txt"); fs.writeFileSync(secret, "first\n");
  fs.symlinkSync(secret, path.join(f.ctx.cwd, "src/link"));
  const before = readDeliveryContinuation(f.ctx, dependencies).key;
  fs.writeFileSync(secret, "second\n");
  assert.equal(readDeliveryContinuation(f.ctx, dependencies).key, before, "symlink target content must not be followed");
});

test("tracked edits and deletion are progress, not stat changes or reverted content", t => {
  const f = fixture(t), file = path.join(f.ctx.cwd, "one.spec.ts");
  const git = (...args) => execFileSync("git", args, { cwd: f.ctx.cwd });
  fs.writeFileSync(file, "baseline\n"); git("add", "one.spec.ts");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "test baseline");
  f.state.task_run = { task_id: "one" }; f.write("gate-state.json", f.state);
  const dependencies = { readBinding: () => ({ ok: true, grant: { task_id: "one" },
    task: { locked_tests: [{ path: "one.spec.ts" }], allowed_writes: ["moved.spec.ts"] } }) };
  const pending = () => readDeliveryContinuation(f.ctx, dependencies).key;
  const clean = pending();
  fs.writeFileSync(file, "staged RED\n"); git("add", "--", "one.spec.ts");
  fs.writeFileSync(file, "baseline\n");
  assert.notEqual(pending(), clean, "staged work must remain visible when working bytes match HEAD");
  git("add", "--", "one.spec.ts"); assert.equal(pending(), clean);
  fs.writeFileSync(file, "new RED\n"); const dirty = pending();
  assert.notEqual(dirty, clean);
  fs.utimesSync(file, new Date(), new Date()); assert.equal(pending(), dirty);
  fs.unlinkSync(file); assert.notEqual(pending(), dirty);
  fs.writeFileSync(file, "new RED\n"); assert.equal(pending(), dirty);
  fs.writeFileSync(file, "baseline\n"); assert.equal(pending(), clean);
  fs.renameSync(file, path.join(f.ctx.cwd, "moved.spec.ts"));
  const renamed = pending(); git("add", "--", "one.spec.ts", "moved.spec.ts");
  assert.equal(pending(), renamed, "rename detection must not turn staging into progress");
});

test("pinned native Pi drains agent_end follow-up without a new operator prompt", { timeout: 20000 }, async t => {
  const sdk = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const f = fixture(t), agentDir = path.join(f.ctx.cwd, "agent");
  const faux = fauxProvider(); let calls = 0;
  faux.setResponses([() => { calls++; return fauxAssistantMessage("Captured; reviews pending."); },
    () => { calls++; return fauxAssistantMessage("Reviews finished."); }]);
  const loader = new sdk.DefaultResourceLoader({ cwd: f.ctx.cwd, agentDir, noExtensions: true, noSkills: true,
    noPromptTemplates: true, noThemes: true, extensionFactories: [pi => {
      const end = installDeliveryContinuation(pi, { local: true, readPending: ctx => calls === 1
        ? { sessionId: ctx.sessionManager.getSessionId(), stage: "task-reviews", key: "native-capture", content: "Finish the pending review." } : null });
      pi.on("agent_end", end);
    }] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: path.join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const { session } = await sdk.createAgentSession({ cwd: f.ctx.cwd, agentDir, resourceLoader: loader,
    modelRuntime: runtime, model: faux.getModel(), sessionManager: sdk.SessionManager.inMemory(f.ctx.cwd),
    settingsManager: sdk.SettingsManager.inMemory() });
  try {
    await session.bindExtensions({});
    await session.prompt("Complete the authorized task.");
    assert.equal(calls, 2);
    assert.equal(session.messages.filter(m => m.role === "user").length, 1, "one operator prompt only");
    assert.equal(session.messages.filter(m => m.role === "assistant").length, 2);
  } finally { session.dispose(); }
});
