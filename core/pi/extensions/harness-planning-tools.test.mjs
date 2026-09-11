import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import harnessPlanningTools from "./harness-planning-tools.ts";
import { writePiChildIdentity } from "../lib/pi-child-identity.mjs";
import { PLANNING_TOOLS } from "../lib/planning-tools.mjs";
import { decidePiPolicy } from "../lib/policy.mjs";
import { runNativeToolCall } from "./pi-native-tool.test.mjs";

test("optional adapter loads only on retrieval and shutdown cancels pending startup", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-planning-lazy-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tools = new Map(), handlers = new Map();
  let loads = 0, stops = 0, finishStart;
  const started = new Promise((resolve) => { finishStart = resolve; });
  await harnessPlanningTools({ registerTool: (tool) => tools.set(tool.name, tool), on: (name, handler) => handlers.set(name, handler) }, {
    adapterFactory: (pi) => {
      loads++;
      pi.on("session_start", () => started);
      pi.on("session_shutdown", () => { stops++; finishStart(); });
      pi.registerTool({ name: "mcp", execute: () => { throw Error("closed adapter must not execute"); } });
    },
  });
  assert.equal(loads, 0);
  const sessionId = "lazy-planner";
  assert.equal(writePiChildIdentity(cwd, { parentSessionId: "parent", childSessionId: sessionId, role: "harness-planner", callId: sessionId }).ok, true);
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ parentSession: "parent" }) } };
  await tools.get("harness_complexity").execute("score", { source: "const x=1" }, undefined, undefined, ctx);
  assert.equal(loads, 0);
  const retrieval = tools.get("mv_recall").execute("recall", { query: "ownership" }, undefined, undefined, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loads, 1);
  await handlers.get("session_shutdown")({ type: "session_shutdown" }, ctx);
  assert.equal(stops, 1);
  assert.equal((await retrieval).details.available, false);
});

test("native planning tools are usable by both planning roles, read-only and fail-open", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-planning-tools-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tools = new Map();
  await harnessPlanningTools({ registerTool: (tool) => tools.set(tool.name, tool) }, { call: null });
  assert.deepEqual([...tools.keys()], PLANNING_TOOLS);
  for (const role of ["harness-planner", "harness-plan-reviewer"]) {
    const sessionId = `child-${role}`;
    assert.equal(writePiChildIdentity(cwd, { parentSessionId: "parent", childSessionId: sessionId, role, callId: sessionId }).ok, true);
    const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ parentSession: "parent" }) } };
    for (const name of PLANNING_TOOLS) assert.equal(decidePiPolicy({ toolName: name }, { reviewerRole: role }).block, false);
    const scored = await runNativeToolCall({ tool: tools.get("harness_complexity"), input: { source: "if (x) work();\n".repeat(65) }, ctx });
    assert.equal(scored.result.details.should_split, true);
    assert.equal(scored.result.details.complexity, "x-high");
    const absent = await runNativeToolCall({ tool: tools.get("mv_recall"), input: { query: "atomic ownership" }, ctx });
    assert.equal(absent.result.details.available, false);
    assert.equal(absent.result.isError, false);
  }
  for (const role of ["harness-adversary", "harness-security", "harness-test-reviewer"]) {
    assert.equal(decidePiPolicy({ toolName: "mp_retrieve" }, { reviewerRole: role }).block, true);
  }
  const denied = await tools.get("mp_retrieve").execute("call", { operation: "read", path: "/core/x" }, undefined, undefined, { cwd, sessionManager: { getSessionId: () => "unknown", getHeader: () => ({}) } });
  assert.equal(denied.details.available, false);
});
