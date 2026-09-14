import test from "node:test";
import assert from "node:assert/strict";
import tracker from "./harness-plan-tracker.ts";

test("idle parent UI observes completion and persists 6/6 without another model message", async t => {
  const handlers = new Map(), entries = [], statuses = []; let tool;
  let status = "in_progress";
  const pi = { on: (name, handler) => handlers.set(name, handler), registerTool: value => tool = value,
    appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }) };
  const ctx = { cwd: "/tmp", sessionManager: { getSessionId: () => "parent", getHeader: () => ({ id: "parent" }), getBranch: () => entries },
    ui: { setStatus: (_name, value) => statuses.push(value), setWidget: () => {} } };
  tracker(pi, { intervalMs: 10, readProgress: () => ({ featureId: "issue", tasks: Array.from({ length: 6 }, (_, i) => ({
    canonicalTaskId: `canonical-${i}`, title: `Task ${i}`, status: i === 4 ? status : "completed", validationStatus: i === 4 && status !== "completed" ? "pending" : "passed",
  })) }) });
  handlers.get("session_start")({}, ctx);
  t.after(() => handlers.get("session_shutdown")({}, ctx));
  assert.match(statuses.at(-1), /5\/6/);
  status = "completed";
  const deadline = Date.now() + 1000;
  while (!statuses.at(-1)?.includes("6/6") && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  assert.match(statuses.at(-1), /6\/6.*concluído/);
  assert.equal(entries.length, 2, "only changed snapshots are persisted");
  const result = await tool.execute("show", { action: "show" }, undefined, undefined, ctx);
  assert.match(result.content[0].text, /Validação 6\/6/);
  handlers.get("session_tree")({}, ctx);
  assert.equal(entries.length, 2, "restoring the session does not duplicate progress");
});

test("native child session cannot replace or poll the parent plan", () => {
  const handlers = new Map(); let reads = 0;
  tracker({ on: (n, h) => handlers.set(n, h), registerTool() {}, appendEntry() { throw new Error("child write"); } },
    { readProgress: () => { reads++; return null; } });
  const ctx = { sessionManager: { getHeader: () => ({ parentSession: "parent" }) } };
  handlers.get("session_start")({}, ctx);
  assert.equal(reads, 0);
});
