import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { enqueueInboxMessage, listBridgeEvents } from "../../control-plane/lib/protocol.mjs";
import { atomicWriteJson, ensureControlHome, ensurePrivateDirectory } from "../../control-plane/lib/storage.mjs";

test("optional Pi bridge binds only the real global parent and preserves decision lifecycle", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-control-bridge-"));
  const home = ensureControlHome(path.join(root, "home"));
  const worktree = fs.realpathSync(fs.mkdirSync(path.join(root, "worktree"), { recursive: true }) ?? path.join(root, "worktree"));
  const deliveryDir = ensurePrivateDirectory(path.join(home, "deliveries", "delivery-one"));
  ensurePrivateDirectory(path.join(deliveryDir, "inbox"));
  ensurePrivateDirectory(path.join(deliveryDir, "inbox", "handled"));
  atomicWriteJson(path.join(deliveryDir, "bridge.json"), {
    schema: "harness.control.bridge.v1", protocol: 1,
    project_id: "project-one", delivery_id: "delivery-one", binding_token: "binding-one",
    generation: 1, session_id: null, cwd: worktree, worktree_id: "worktree-one", created_at: new Date().toISOString(),
  });

  const previous = process.env.HARNESS_CONTROL_BINDING;
  process.env.HARNESS_CONTROL_BINDING = deliveryDir;
  try {
    const { default: install } = await import(`./harness-control-plane.ts?test=${Date.now()}`);
    assert.equal(process.env.HARNESS_CONTROL_BINDING, undefined);
    const handlers = new Map();
    let tool;
    install({
      on(name, handler) { handlers.set(name, handler); },
      registerTool(definition) { tool = definition; },
    });
    const ctx = {
      cwd: worktree,
      sessionManager: {
        getSessionId: () => "session-real",
        getHeader: () => ({ id: "session-real" }),
      },
      ui: { notify() {} },
      shutdown() { throw new Error("bridge should not shut down a valid parent"); },
    };
    await handlers.get("session_start")({}, ctx);
    assert.equal(listBridgeEvents(deliveryDir)[0].type, "session.started");
    const prompt = handlers.get("before_agent_start")({ systemPrompt: "base" }, ctx);
    assert.match(prompt.systemPrompt, /global parent is controlled/);

    const opened = await tool.execute("call-1", {
      action: "decision-opened", decision_id: "d1", revision: 1,
      summary: "Choose", options: ["A", "B"], recommendation: "A",
    }, undefined, undefined, ctx);
    assert.equal(opened.details.ok, true);
    await enqueueInboxMessage(deliveryDir, { message_id: "answer-one", decision_id: "d1", revision: 1, answer: "A" });
    const inbox = await tool.execute("call-2", { action: "inbox" }, undefined, undefined, ctx);
    assert.equal(inbox.details.messages[0].origin, "operator");
    const applied = await tool.execute("call-3", {
      action: "decision-applied", message_id: "answer-one", decision_id: "d1", revision: 1,
      evidence: ".pi/harness/state/gate.json#d1",
    }, undefined, undefined, ctx);
    assert.equal(applied.details.ok, true);

    const unprovenCompletion = await tool.execute("call-4", {
      action: "completed", event_id: "completed-unproven", detail: "done",
      evidence: "model-says-done",
    }, undefined, undefined, ctx);
    assert.equal(unprovenCompletion.details.ok, false);
    const stateDir = path.join(worktree, ".pi", "harness", "state", "session-real");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "gate-state.json"), JSON.stringify({
      session_id: "session-real", final_review_done: true,
    }));
    const completed = await tool.execute("call-5", {
      action: "completed", event_id: "completed-proven", detail: "done",
    }, undefined, undefined, ctx);
    assert.equal(completed.details.ok, true);
    assert.equal(completed.details.event.payload.evidence, ".pi/harness/state/session-real/gate-state.json#final_review_done");

    const child = { ...ctx, sessionManager: { getSessionId: () => "child", getHeader: () => ({ id: "child", parentSession: "session-real" }) } };
    const refused = await tool.execute("call-child", { action: "inbox" }, undefined, undefined, child);
    assert.equal(refused.details.ok, false);
    assert.match(refused.details.reason, /global-parent-only/);

    await handlers.get("session_shutdown")({}, ctx);
    assert.deepEqual(listBridgeEvents(deliveryDir).map((event) => event.type), [
      "session.started", "decision.opened", "decision.response-received", "decision.applied", "result.completed", "session.stopped",
    ]);
  } finally {
    if (previous === undefined) delete process.env.HARNESS_CONTROL_BINDING;
    else process.env.HARNESS_CONTROL_BINDING = previous;
  }
});
