import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiReviewConcurrency,
  isPiSubagentDescendant,
} from "./pi-review-concurrency.mjs";

function fakePi() {
  const handlers = new Map();
  return {
    handlers,
    tools: new Map(),
    events: { emit() {} },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) { this.tools.set(tool.name, tool); },
  };
}

test("the native execute and descendant extension factories share one module-level ALS", async () => {
  const pi = fakePi();
  const observed = [];
  const wrapped = createPiReviewConcurrency({ bindChildSession: () => ({ ok: true }) })
    .wrapNativeFactory((api) => {
      api.registerTool({
        name: "subagent",
        async execute() {
          observed.push(isPiSubagentDescendant());
          await Promise.resolve();
          observed.push(isPiSubagentDescendant());
          return "done";
        },
      });
    });
  wrapped(pi);

  assert.equal(isPiSubagentDescendant(), false);
  assert.equal(await pi.tools.get("subagent").execute("call-1", {
    subagent_type: "harness-adversary",
    prompt: "[HARNESS_FINAL_REVIEW] review",
  }), "done");
  assert.deepEqual(observed, [true, true]);
  assert.equal(isPiSubagentDescendant(), false);
});

test("bound verification is synchronous and rejects before native execute can finish", async () => {
  const pi = fakePi();
  const checks = [];
  const wrapped = createPiReviewConcurrency({
    bindChildSession: () => ({ ok: true }),
    verifyChildBound(payload) {
      checks.push(payload);
      return { ok: false, reason: "mandatory policy rail missing" };
    },
  }).wrapNativeFactory((api) => {
    api.registerTool({
      name: "subagent",
      async execute(_id, _params, _signal) {
        api.events.emit("subagents:child:session-created", { sessionId: "child-1", parentSessionId: "parent-1" });
        api.events.emit("subagents:child:bound", { sessionId: "child-1", parentSessionId: "parent-1", extensions: {} });
        return "must not complete";
      },
    });
  });
  wrapped(pi);

  await assert.rejects(
    pi.tools.get("subagent").execute("call-1", { subagent_type: "harness-adversary", prompt: "[HARNESS_FINAL_REVIEW] review" }),
    /mandatory policy rail missing/,
  );
  assert.equal(checks.length, 1);
  assert.equal(checks[0].sessionId, "child-1");
});
