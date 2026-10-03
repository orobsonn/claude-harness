import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createAdmissionServer, acquireAdmission, startCoordinator } from "./provider-request-control.mjs";
import { installProviderHttpTrace, providerTraceEnvironment } from "./provider-http-trace.mjs";

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "verboo-control-"));
  const socketPath = path.join(directory, "gate.sock");
  const server = createAdmissionServer({ idleMs: 0, ...options });
  server.listen(socketPath); await once(server, "listening");
  t.after(async () => { server.closeAdmissions(); await once(server, "close"); fs.rmSync(directory, { recursive: true, force: true }); });
  return { server, socketPath };
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("Verboo launchers enable admission by default while Ollama needs no preload", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-provider-auto-gate-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const original = { EXISTING: "kept" };
  const verboo = providerTraceEnvironment(original, { userHome: home, providerId: "verboo", sessionId: "new" });
  assert.match(verboo.PI_HARNESS_VERBOO_CONTROL_SOCKET, /provider-control\/verboo.sock$/);
  assert.match(verboo.NODE_OPTIONS, /provider-http-trace/);
  assert.equal(verboo.PI_HARNESS_HTTP_TRACE_DIR, undefined);
  assert.equal(providerTraceEnvironment(original, { userHome: home, providerId: "ollama" }), original);
});

test("one queue shares two slots between independent connections and grants FIFO", async (t) => {
  const { socketPath } = await fixture(t);
  const a = await acquireAdmission(socketPath), b = await acquireAdmission(socketPath);
  const order = [];
  const c = acquireAdmission(socketPath).then((lease) => { order.push("c"); return lease; });
  const d = acquireAdmission(socketPath).then((lease) => { order.push("d"); return lease; });
  await pause(30); assert.deepEqual(order, []);
  a.release(); const lc = await c; assert.deepEqual(order, ["c"]);
  b.release(); const ld = await d; assert.deepEqual(order, ["c", "d"]);
  lc.release(); ld.release();
});

test("RPM counts each admission even after the previous HTTP attempt failed/released", async (t) => {
  const { socketPath } = await fixture(t, { requestsPerWindow: 2, windowMs: 180 });
  const start = Date.now();
  (await acquireAdmission(socketPath)).release();
  (await acquireAdmission(socketPath)).release();
  const third = await acquireAdmission(socketPath);
  assert.ok(Date.now() - start >= 165); third.release();
});

test("cancelling a queued request does not consume RPM or leave a slot", async (t) => {
  const { socketPath } = await fixture(t, { maxConcurrent: 1, requestsPerWindow: 2, windowMs: 1000 });
  const a = await acquireAdmission(socketPath);
  const controller = new AbortController();
  const pending = acquireAdmission(socketPath, { signal: controller.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await pause(20); controller.abort(); await rejected;
  a.release();
  const start = Date.now(); const b = await acquireAdmission(socketPath);
  assert.ok(Date.now() - start < 300); b.release();
});

test("a bounded wait fails without sending a request and leaves the queue usable", async (t) => {
  const { socketPath } = await fixture(t, { maxConcurrent: 1 });
  const a = await acquireAdmission(socketPath);
  await assert.rejects(acquireAdmission(socketPath, { waitMs: 25 }), /queue wait expired/);
  a.release(); (await acquireAdmission(socketPath)).release();
});

test("process death closes its lease and unblocks the next process", async (t) => {
  const { socketPath } = await fixture(t, { maxConcurrent: 1 });
  const moduleUrl = new URL("./provider-request-control.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {acquireAdmission} from ${JSON.stringify(moduleUrl)}; await acquireAdmission(${JSON.stringify(socketPath)}); console.log('acquired');`], { stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  await once(child.stdout, "data");
  let entered = false;
  const next = acquireAdmission(socketPath).then((lease) => { entered = true; return lease; });
  await pause(20); assert.equal(entered, false);
  child.kill("SIGKILL"); (await next).release();
});

test("loss of the coordinator aborts a granted transport instead of losing its lease silently", async (t) => {
  const { server, socketPath } = await fixture(t);
  const lease = await acquireAdmission(socketPath);
  const aborted = once(lease.signal, "abort");
  server.closeAdmissions(); await aborted;
  assert.match(lease.signal.reason.message, /coordinator disconnected/);
});

test("fetch admission holds its slot until the streaming body is cancelled and preserves bytes", async (t) => {
  const { socketPath } = await fixture(t, { maxConcurrent: 1 });
  let started = 0;
  const target = { fetch: async () => {
    started++;
    return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"x":1}\n\n')); } }), { headers: { "content-type": "text/event-stream" } });
  } };
  installProviderHttpTrace({ target, controlSocket: socketPath });
  const url = "https://code.verboo.ai/router/v1/chat/completions";
  const first = await target.fetch(url);
  const reader = first.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"x":1}\n\n');
  const second = target.fetch(url); await pause(30); assert.equal(started, 1);
  await reader.cancel(); const response = await second;
  assert.equal(started, 2); await response.body.cancel();
});

test("HTTP errors and fetch failures release slots; unrelated providers never enter this queue", async (t) => {
  const { socketPath } = await fixture(t, { maxConcurrent: 1 });
  let admissions = 0, calls = 0;
  const target = { fetch: async () => { if (++calls === 1) throw new Error("network failure"); return new Response('oops', { status: 503 }); } };
  installProviderHttpTrace({ target, controlSocket: socketPath, acquire: async (...args) => { admissions++; return acquireAdmission(...args); } });
  const url = "https://code.verboo.ai/router/v1/chat/completions";
  await assert.rejects(target.fetch(url), /network failure/);
  assert.equal((await target.fetch(url)).status, 503);
  assert.equal((await target.fetch("https://ollama.com/v1/chat/completions")).status, 503);
  assert.equal(admissions, 2);
});

test("host control enables the existing preload without enabling trace or changing project settings", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "verboo-control-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".config", "claude-harness"); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "provider-request-control.json"), '{"verboo":true}');
  const env = providerTraceEnvironment({ EXISTING: "kept" }, { userHome: home, modulePath: "/trace.mjs", sessionId: "test" });
  assert.equal(env.PI_HARNESS_VERBOO_CONTROL_SOCKET, path.join(home, ".cache", "claude-harness", "provider-control", "verboo.sock"));
  assert.equal(env.PI_HARNESS_HTTP_TRACE_DIR, undefined);
  assert.equal(env.NODE_OPTIONS, '--import="/trace.mjs"');
  assert.equal(env.EXISTING, "kept");
});

test("the detached coordinator boots once on a private socket and concurrent callers share it", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "verboo-control-boot-"));
  const socketPath = path.join(directory, "private", "gate.sock");
  const children = [];
  const start = (socket) => { const child = startCoordinator(socket); children.push(child); };
  t.after(() => { for (const child of children) child.kill(); fs.rmSync(directory, { recursive: true, force: true }); });
  const [a, b] = await Promise.all([acquireAdmission(socketPath, { start }), acquireAdmission(socketPath, { start })]);
  assert.equal(fs.statSync(path.dirname(socketPath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o700);
  let entered = false;
  const next = acquireAdmission(socketPath, { start }).then((lease) => { entered = true; return lease; });
  await pause(25); assert.equal(entered, false);
  a.release(); (await next).release(); b.release();
});

test("queue overflow fails explicitly and a cancelled body error releases admission", async (t) => {
  const { socketPath } = await fixture(t, { maxConcurrent: 1, maxQueued: 1 });
  const a = await acquireAdmission(socketPath);
  const pending = acquireAdmission(socketPath);
  await pause(10);
  await assert.rejects(acquireAdmission(socketPath), /queue capacity exceeded/);
  a.release(); (await pending).release();
  const target = { fetch: async () => new Response(new ReadableStream({ pull(c) { c.error(new Error("broken body")); } })) };
  installProviderHttpTrace({ target, controlSocket: socketPath });
  const response = await target.fetch("https://code.verboo.ai/router/v1/chat/completions");
  await assert.rejects(response.text(), /broken body/);
  (await acquireAdmission(socketPath)).release();
});
