import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installProviderHttpTrace, providerTraceEnvironment, TRACE_DIR_ENV } from "./provider-http-trace.mjs";

const endpoint = "https://code.verboo.ai/router/v1/chat/completions";

test("invalid Verboo limits fail its launch without blocking an Ollama launch", t => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "verboo-invalid-limits-"));
  t.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const directory = path.join(userHome, ".config/claude-harness");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "provider-request-control.json"), JSON.stringify({ verboo: { maxConcurrent: 7 } }));
  assert.throws(() => providerTraceEnvironment({}, { userHome, providerId: "verboo" }), /maxConcurrent/);
  assert.deepEqual(providerTraceEnvironment({}, { userHome, providerId: "ollama-cloud" }), {});
});

test("a late dispatcher installation retains tracing and uses the replacement transport", async () => {
  const rows = [];
  let oldCalls = 0;
  let newCalls = 0;
  const target = { fetch: async () => { oldCalls++; return new Response("old"); } };
  installProviderHttpTrace({ target, append: (row) => rows.push(row), trackFetchReplacement: true });
  const wrapped = target.fetch;
  target.fetch = async () => { newCalls++; return new Response("new", { status: 429 }); };
  assert.notEqual(target.fetch, wrapped);
  assert.equal(await (await target.fetch(endpoint)).text(), "new");
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
  assert.equal(rows[1].status, 429);
  target.fetch = wrapped;
  assert.equal(target.fetch, wrapped);
  assert.equal(await (await target.fetch(endpoint)).text(), "old");
  assert.equal(oldCalls, 1);
  assert.equal(newCalls, 1);
});

test("fetch mocks retain identity on restoration and saved transports do not change", async () => {
  const target = { fetch: async () => new Response("original") };
  installProviderHttpTrace({ target, append: () => {}, trackFetchReplacement: true });
  const saved = target.fetch;
  const mock = async () => new Response("mock");
  target.fetch = mock;
  const wrappedMock = target.fetch;
  assert.notEqual(wrappedMock, saved);
  assert.equal(await (await saved("https://example.invalid")).text(), "original");
  assert.equal(await (await target.fetch("https://example.invalid")).text(), "mock");
  target.fetch = saved;
  assert.equal(target.fetch, saved);
  assert.equal(await (await target.fetch("https://example.invalid")).text(), "original");
  target.fetch = mock;
  assert.equal(target.fetch, wrappedMock);
  target.fetch = undefined;
  assert.equal(target.fetch, undefined);
  target.fetch = wrappedMock;
  assert.equal(target.fetch, wrappedMock);
  assert.equal(await (await target.fetch(endpoint)).text(), "mock");
});

test("HTTP trace preserves SSE bytes and captures status/timing without prompts or credentials", async () => {
  const rows = [];
  const payload = 'data: {"choices":[{"delta":{"content":"private response"}}]}\n\ndata: [DONE]\n\n';
  const target = { fetch: async () => new Response(payload, { headers: {
    "content-type": "text/event-stream", authorization: "secret response header", "x-ratelimit-limit": "40",
  } }) };
  assert.equal(installProviderHttpTrace({ target, append: (row) => rows.push(row) }), true);
  const response = await target.fetch(endpoint, { headers: { authorization: "secret api key" }, body: "private prompt" });
  assert.equal(await response.text(), payload);
  assert.deepEqual(rows.map((r) => r.event), ["request", "headers", "first_byte", "stream_end"]);
  assert.equal(rows[1].status, 200);
  assert.equal(rows[3].end_type, "done");
  assert.equal(rows[1].headers["x-ratelimit-limit"], "40");
  assert.doesNotMatch(JSON.stringify(rows), /secret|private|authorization/);
});

test("EOF without DONE is observable without converting it into a valid completion", async () => {
  const rows = [];
  const payload = 'data: {"choices":[{"delta":{"reasoning_content":"private partial thinking"}}]}\n\n';
  const target = { fetch: async () => new Response(payload, { headers: { "content-type": "text/event-stream" } }) };
  installProviderHttpTrace({ target, append: (row) => rows.push(row) });
  assert.equal(await (await target.fetch(endpoint)).text(), payload);
  assert.equal(rows.at(-1).end_type, "eof");
  assert.doesNotMatch(JSON.stringify(rows), /private partial thinking/);
});

test("trace counts separate retry attempts and returns failed responses unchanged", async () => {
  const rows = [];
  const failed = new Response("private error", { status: 429, headers: { "retry-after": "59" } });
  const target = { fetch: async () => failed };
  installProviderHttpTrace({ target, append: (row) => rows.push(row) });
  assert.equal(await target.fetch(endpoint), failed);
  assert.equal(await target.fetch(endpoint), failed);
  assert.equal(rows.filter((r) => r.event === "request").length, 2);
  assert.equal(new Set(rows.map((r) => r.request_id)).size, 2);
  assert.equal(rows[1].headers["retry-after"], "59");
  assert.doesNotMatch(JSON.stringify(rows), /private error/);
});

test("unrelated providers and failed log writes do not change inference", async () => {
  let calls = 0;
  const target = { fetch: async () => { calls++; return new Response("ok"); } };
  const rows = [];
  installProviderHttpTrace({ target, append: (row) => rows.push(row) });
  assert.equal(await (await target.fetch("https://other.example/chat/completions")).text(), "ok");
  assert.equal(rows.length, 0);
  const broken = { fetch: async () => new Response("ok") };
  installProviderHttpTrace({ target: broken, append: () => { throw new Error("disk full"); } });
  assert.equal(await (await broken.fetch(endpoint)).text(), "ok");
  assert.equal(calls, 1);
});

test("aborted request records only the error type and rethrows the same exception", async () => {
  const error = new DOMException("private token in exception", "AbortError");
  const rows = [];
  const target = { fetch: async () => { throw error; } };
  installProviderHttpTrace({ target, append: (row) => rows.push(row) });
  await assert.rejects(target.fetch(endpoint), (e) => e === error);
  assert.equal(rows.at(-1).error_type, "AbortError");
  assert.doesNotMatch(JSON.stringify(rows), /private token/);
});

test("opt-in host configuration adds a quoted preload and preserves existing Node options", (t) => {
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-trace-host-"));
  t.after(() => fs.rmSync(userHome, { recursive: true, force: true }));
  const env = { NODE_OPTIONS: "--max-old-space-size=2048" };
  assert.equal(providerTraceEnvironment(env, { userHome }), env);
  const directory = path.join(userHome, "trace");
  const config = path.join(userHome, ".config", "claude-harness", "provider-tracing.json");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ verboo: { directory } }));
  const prepared = providerTraceEnvironment(env, { userHome, sessionId: "session-a", modulePath: "/path with space/trace.mjs" });
  assert.equal(prepared[TRACE_DIR_ENV], directory);
  assert.match(prepared.NODE_OPTIONS, /--max-old-space-size=2048 --import="\/path with space\/trace.mjs"/);
  assert.deepEqual(env, { NODE_OPTIONS: "--max-old-space-size=2048" });
  assert.equal(providerTraceEnvironment({ [TRACE_DIR_ENV]: "relative" }, { userHome })[TRACE_DIR_ENV], "relative");
});
