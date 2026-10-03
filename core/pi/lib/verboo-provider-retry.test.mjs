import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { registerVerbooProviderRetry } from "./verboo-provider-retry.mjs";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

test("Verboo wraps only its own stream, preserves transport options and respects explicit retry limits", () => {
  let registered, received;
  const sentinel = {};
  registerVerbooProviderRetry({ registerProvider(id, config) { registered = { id, config }; } },
    (...args) => { received = args; return sentinel; });
  assert.equal(registered.id, "verboo");
  const model = {}, context = {}, signal = new AbortController().signal;
  assert.equal(registered.config.streamSimple(model, context, { signal, apiKey: "fixture" }), sentinel);
  assert.deepEqual(received, [model, context, { signal, apiKey: "fixture", maxRetries: 30, maxRetryDelayMs: 60000 }]);
  registered.config.streamSimple(model, context, { maxRetries: 0, maxRetryDelayMs: 1000 });
  assert.equal(received[2].maxRetries, 0);
  assert.equal(received[2].maxRetryDelayMs, 1000);
});

test("native ModelRuntime registration honors Retry-After before delivering a recovered stream", async (t) => {
  let attempts = [];
  let mode = "recover";
  const server = http.createServer((req, res) => {
    req.resume(); attempts.push(performance.now());
    if (mode === "rate-limited" || (mode === "recover" && attempts.length === 1)) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0.04" });
      res.end(JSON.stringify({ error: { message: "fixture rate limit", type: "rate_limit_error" } }));
    } else if (mode === "partial") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  registry.registerProvider("verboo", { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  registerVerbooProviderRetry(registry, builtinProviders().find((provider) => provider.id === "deepseek").streamSimple);
  const message = await registry.streamSimple(registry.getModel("verboo", "fixture"),
    { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, { apiKey: "offline-fixture" }).result();
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1] - attempts[0] >= 35);
  attempts = []; mode = "rate-limited";
  const exhausted = await registry.streamSimple(registry.getModel("verboo", "fixture"),
    { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, { apiKey: "offline-fixture", maxRetries: 2 }).result();
  assert.equal(exhausted.stopReason, "error");
  assert.equal(attempts.length, 3, "initial HTTP attempt plus two retries");
  attempts = []; mode = "partial";
  await registry.streamSimple(registry.getModel("verboo", "fixture"),
    { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, { apiKey: "offline-fixture" }).result();
  assert.equal(attempts.length, 1, "HTTP 200 partial streams must not be replayed by the transport");
});


test("Verboo survives a sustained pre-stream outage and stops at the finite retry budget", async (t) => {
  let attempts = 0, failures = 12;
  const server = http.createServer((req, res) => {
    req.resume(); attempts++;
    if (attempts <= failures) {
      res.writeHead(503, { "content-type": "application/json", "retry-after": "0.001" });
      res.end(JSON.stringify({ error: { message: "fixture temporarily unavailable" } }));
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"id":"fixture","choices":[{"index":0,"delta":{"content":"recovered"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  registry.registerProvider("verboo", { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  registerVerbooProviderRetry(registry, builtinProviders().find((provider) => provider.id === "deepseek").streamSimple);
  const context = { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] };
  const run = (options = {}) => registry.streamSimple(registry.getModel("verboo", "fixture"), context, { apiKey: "offline-fixture", ...options }).result();
  const recovered = await run();
  assert.equal(recovered.stopReason, "stop", recovered.errorMessage);
  assert.equal(attempts, 13, "same inference must survive beyond the old two-retry budget");
  attempts = 0; failures = Infinity;
  const exhausted = await run();
  assert.equal(exhausted.stopReason, "error");
  assert.equal(attempts, 31, "one initial request and at most thirty HTTP retries, never an endless restart");
  attempts = 0;
  await run({ maxRetries: 0 });
  assert.equal(attempts, 1, "an explicit disabled retry budget remains authoritative");
});

test("Verboo does not retry authentication/payment failures and cancellation interrupts its wait", async (t) => {
  let attempts = 0, status = 401, delay = "0.001", firstRequest;
  const server = http.createServer((req, res) => {
    req.resume(); attempts++;
    res.writeHead(status, { "content-type": "application/json", "retry-after": delay });
    res.end(JSON.stringify({ error: { message: "fixture provider failure" } }));
    firstRequest?.();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const registry = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  registry.registerProvider("verboo", { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] });
  registerVerbooProviderRetry(registry, builtinProviders().find((provider) => provider.id === "deepseek").streamSimple);
  const run = (options = {}) => registry.streamSimple(registry.getModel("verboo", "fixture"),
    { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, { apiKey: "offline-fixture", ...options }).result();
  for (const code of [400, 401, 402, 403]) {
    attempts = 0; status = code;
    const failed = await run();
    assert.equal(failed.stopReason, "error");
    assert.equal(attempts, 1, `HTTP ${code} must not enter outage retry`);
  }
  attempts = 0; status = 503; delay = "61";
  const excessiveDelay = await run();
  assert.equal(excessiveDelay.stopReason, "error");
  assert.match(excessiveDelay.errorMessage, /Server requested 61s retry delay/);
  assert.equal(attempts, 1, "server backoff above the permitted limit terminates");
  attempts = 0; delay = "60";
  const controller = new AbortController();
  const observed = new Promise((resolve) => { firstRequest = resolve; });
  const pending = run({ signal: controller.signal });
  await observed;
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  const result = await pending;
  assert.equal(result.stopReason, "aborted");
  assert.equal(attempts, 1, "cancel must not spawn another HTTP attempt");
});
