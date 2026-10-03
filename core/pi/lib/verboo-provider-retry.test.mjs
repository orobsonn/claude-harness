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
  assert.deepEqual(received, [model, context, { signal, apiKey: "fixture", maxRetries: 2, maxRetryDelayMs: 60000 }]);
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
    { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, { apiKey: "offline-fixture" }).result();
  assert.equal(exhausted.stopReason, "error");
  assert.equal(attempts.length, 3, "initial HTTP attempt plus two retries");
  attempts = []; mode = "partial";
  await registry.streamSimple(registry.getModel("verboo", "fixture"),
    { messages: [{ role: "user", content: "fixture", timestamp: Date.now() }] }, { apiKey: "offline-fixture" }).result();
  assert.equal(attempts.length, 1, "HTTP 200 partial streams must not be replayed by the transport");
});
