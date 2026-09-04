import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import harnessPolicy from "./harness-policy.ts";

const SESSION = "ses-policy-parent";

function fixture(mode = "FULL") {
  const root = mkdtempSync(join(tmpdir(), "pi-policy-extension-"));
  const stateDir = join(root, ".pi", "harness", "state", SESSION);
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, "gate-state.json"),
    JSON.stringify({ session_id: SESSION, feature_id: "policy-extension", classified: true, mode }),
  );
  return { root, close: () => rmSync(root, { recursive: true, force: true }) };
}

function handler() {
  const registered = new Map();
  harnessPolicy({ on: (name, fn) => registered.set(name, fn) });
  assert.equal(typeof registered.get("tool_call"), "function");
  return registered.get("tool_call");
}

function parentCtx(cwd) {
  return {
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionId: () => SESSION,
      getHeader: () => ({}),
    },
  };
}

test("adaptador consulta o gate-state e bloqueia escrita nativa do pai em FULL, aplicando a allowlist literal do Claude", () => {
  const f = fixture();
  try {
    const onToolCall = handler();
    for (const event of [
      { toolName: "write", input: { path: "src/app.ts" } },
      { toolName: "edit", input: { path: "tests/app.test.mjs" } },
      { toolName: "bash", input: { command: "printf x > src/app.ts" } },
    ]) {
      const decision = onToolCall(event, parentCtx(f.root));
      assert.equal(decision.block, true);
      assert.match(decision.reason, /parent orchestrator/i);
    }
    assert.equal(onToolCall({ toolName: "bash", input: { command: "npm test" } }, parentCtx(f.root)), undefined);
    assert.equal(onToolCall({ toolName: "bash", input: { command: "git commit -am delegated-hand" } }, parentCtx(f.root)), undefined);
  } finally {
    f.close();
  }
});

test("headless parent cannot write inline before classification while the local parent can", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-headless-unclassified-"));
  try {
    const onToolCall = handler();
    const event = { toolName: "write", input: { path: "src/app.ts", content: "example" } };
    assert.equal(onToolCall(event, parentCtx(root)), undefined);
    const blocked = onToolCall(event, { ...parentCtx(root), hasUI: false });
    assert.equal(blocked?.block, true);
    assert.equal(onToolCall({ toolName: "bash", input: { command: "npm test" } }, { ...parentCtx(root), hasUI: false }), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("suspended ceremony permits local native editing but cannot dispatch or mark delivery", () => {
  const f = fixture();
  try {
    const statePath = join(f.root, ".pi/harness/state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, ceremony_status: "suspended-inline" }));
    const run = (toolName, input = {}, context = parentCtx(f.root)) => handler()({ toolName, input }, context);
    assert.equal(run("write", { path: "src/app.ts", content: "example" }), undefined);
    assert.equal(run("write", { path: "src/app.ts" }, { ...parentCtx(f.root), hasUI: false })?.block, true);
    for (const toolName of ["subagent", "mark", "harness_spec_write", "seal_spec_review"]) assert.equal(run(toolName)?.block, true, toolName);
    assert.equal(run("harness_plan", { action: "update" })?.block, true);
    assert.equal(run("harness_plan", { action: "show" }), undefined);
    assert.equal(run("classify", { mode: "QUICK", feature_id: "replacement" })?.block, true);
    assert.equal(run("classify", { action: "resume-ceremony" }), undefined);
  } finally { f.close(); }
});

test("reconciling permits plan reconciliation but no execution, shipping or final approval", () => {
  const f = fixture();
  try {
    const statePath = join(f.root, ".pi/harness/state", SESSION, "gate-state.json");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(statePath, JSON.stringify({ ...state, ceremony_status: "reconciling" }));
    const run = (toolName, input = {}) => handler()({ toolName, input }, parentCtx(f.root));
    assert.equal(run("write", { path: "src/app.ts" })?.block, true);
    for (const role of ["harness-planner", "harness-plan-reviewer"]) {
      assert.equal(run("subagent", { subagent_type: role }), undefined, role);
    }
    for (const role of ["harness-executor", "harness-sniper", "harness-shipper", "harness-harvester", "harness-discussion-adversary", "harness-test-author"]) {
      assert.equal(run("subagent", { subagent_type: role })?.block, true, role);
    }
    assert.equal(run("mark", { action: "final-review" })?.block, true);
    assert.equal(run("mark", { action: "demo-done" })?.block, true);
    assert.equal(run("mark", { action: "regate-passed", task_id: "task1" })?.block, true);
  } finally { f.close(); }
});

test("unreadable ceremony state never becomes permission for local inline mutation", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.root, ".pi/harness/state", SESSION, "gate-state.json"), "{broken");
    const run = (toolName, input = {}) => handler()({ toolName, input }, parentCtx(f.root));
    for (const toolName of ["write", "edit", "bash", "subagent", "mark", "classify"]) {
      assert.equal(run(toolName, { path: "src/app.ts", command: "node script.mjs" })?.block, true, toolName);
    }
    assert.equal(run("read", { path: "README.md" }), undefined);
  } finally { f.close(); }
});
