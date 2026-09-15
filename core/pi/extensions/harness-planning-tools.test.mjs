import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import harnessPlanningTools from "./harness-planning-tools.ts";
import { writePiChildIdentity } from "../lib/pi-child-identity.mjs";
import { PLANNING_TOOLS } from "../lib/planning-tools.mjs";
import { decidePiPolicy } from "../lib/policy.mjs";
import { runNativeToolCall } from "./pi-native-tool.test.mjs";
import { analyzeSource } from "../../claude-code/skills/creating-plans/references/complexity-scorer.mjs";

test("native plan analysis is advisory, canonical, read-only and delivered to both planning roles", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-plan-analysis-tool-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tools = new Map();
  await harnessPlanningTools({ registerTool: tool => tools.set(tool.name, tool) }, {
    call: () => { throw Error("plan analysis must not use MCP"); },
  });
  mkdirSync(join(cwd, '.pi/harness/plans/demo'), { recursive: true });
  const path = join(cwd, '.pi/harness/plans/demo/execution-plan.json');
  const draft = JSON.stringify({ feature_id: 'demo', tasks: [{ id: 'a', scope_paths: ['new.ts'] }] });
  writeFileSync(path, draft);
  const tool = tools.get('harness_plan_analysis');
  assert.deepEqual(tool.parameters.required, ['feature_id']);
  for (const role of ['harness-planner', 'harness-plan-reviewer']) {
    const sessionId = `analysis-${role}`;
    assert.equal(writePiChildIdentity(cwd, { parentSessionId: 'parent', childSessionId: sessionId, role, callId: sessionId }).ok, true);
    const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ parentSession: 'parent' }) } };
    const stateBefore = readdirSync(join(cwd, '.pi/harness'), { recursive: true }).sort();
    const result = await runNativeToolCall({ tool, input: { feature_id: 'demo' }, ctx });
    assert.equal(result.result.isError, false);
    assert.equal(result.result.details.ok, true);
    assert.equal(result.result.details.validation.ok, false);
    assert.equal(result.result.details.coverage.paths[0].status, 'missing');
    assert.equal((await tool.execute('absent', { feature_id: 'missing' }, undefined, undefined, ctx)).details.ok, false);
    assert.deepEqual(readdirSync(join(cwd, '.pi/harness'), { recursive: true }).sort(), stateBefore);
    assert.equal(readFileSync(path, 'utf8'), draft);
  }
  const denied = await tool.execute('spoof', { feature_id: 'demo' }, undefined, undefined,
    { cwd, sessionManager: { getSessionId: () => 'unknown' } });
  assert.equal(denied.details.available, false);
  for (const role of ['harness-adversary', 'harness-security', 'harness-test-reviewer']) {
    assert.equal(decidePiPolicy({ toolName: 'harness_plan_analysis' }, { reviewerRole: role }).block, true);
  }
});

test("scorer takes an existing file path, not model-supplied pseudocode", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-file-scorer-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tools = new Map();
  await harnessPlanningTools({ registerTool: tool => tools.set(tool.name, tool) }, { call: null });
  const tool = tools.get("harness_complexity");
  assert.deepEqual(tool.parameters.required, ["path"]);
  assert.equal(tool.parameters.properties.source, undefined);
  const path = "workflow.ts", source = "if (condition) run();\n".repeat(65);
  writeFileSync(join(cwd, path), source);
  for (const role of ["harness-planner", "harness-plan-reviewer"]) {
    const sessionId = `file-${role}`;
    assert.equal(writePiChildIdentity(cwd, { parentSessionId: "parent", childSessionId: sessionId, role, callId: sessionId }).ok, true);
    const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ parentSession: "parent" }) } };
    const scored = await runNativeToolCall({ tool, input: { path }, ctx });
    const cc = analyzeSource(path, source);
    for (const key of ["score", "complexity", "should_split", "breakdown", "metrics"]) assert.deepEqual(scored.result.details[key], cc[key]);
    assert.equal(scored.result.details.basis, "whole-file-approximation");
    for (const alias of ["lib/../workflow.ts", join(cwd, path)]) {
      const sameFile = await runNativeToolCall({ tool, input: { path: alias }, ctx });
      for (const key of ["file", "score", "complexity", "should_split", "breakdown", "metrics"]) assert.deepEqual(sameFile.result.details[key], scored.result.details[key]);
    }
    const pseudocode = await runNativeToolCall({ tool, input: { source: "async function f(){ await work(); }" }, ctx });
    assert.equal(pseudocode.result.isError, true);
    assert.equal((await tool.execute("spoof", { path, source: "const trivial=1" }, undefined, undefined, ctx)).details.ok, false);
    const missing = await tool.execute("missing", { path: "not-created.ts" }, undefined, undefined, ctx);
    assert.equal(missing.details.ok, false);
    assert.equal(missing.details.advisory, true);
    writeFileSync(join(cwd, ".env"), "not-a-real-secret");
    symlinkSync(join(cwd, ".env"), join(cwd, "secret-link.ts"));
    assert.equal((await tool.execute("secret", { path: "secret-link.ts" }, undefined, undefined, ctx)).details.ok, false);
    rmSync(join(cwd, "secret-link.ts"));
  }
  assert.equal(readFileSync(join(cwd, path), "utf8"), source);
});

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
  writeFileSync(join(cwd, "simple.ts"), "const x=1");
  await tools.get("harness_complexity").execute("score", { path: "simple.ts" }, undefined, undefined, ctx);
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
  writeFileSync(join(cwd, "complex.ts"), "if (x) work();\n".repeat(65));
  for (const role of ["harness-planner", "harness-plan-reviewer"]) {
    const sessionId = `child-${role}`;
    assert.equal(writePiChildIdentity(cwd, { parentSessionId: "parent", childSessionId: sessionId, role, callId: sessionId }).ok, true);
    const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getHeader: () => ({ parentSession: "parent" }) } };
    for (const name of PLANNING_TOOLS) assert.equal(decidePiPolicy({ toolName: name }, { reviewerRole: role }).block, false);
    const scored = await runNativeToolCall({ tool: tools.get("harness_complexity"), input: { path: "complex.ts" }, ctx });
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
