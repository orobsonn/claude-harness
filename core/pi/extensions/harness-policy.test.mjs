import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import harnessPolicy from "./harness-policy.ts";
import harnessEntryGate from "./harness-entry-gate.ts";

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

test("policy e entry-gate permitem ao pai criar a série real de commits seletivos antes da revisão final", async () => {
  const f = fixture();
  try {
    execFileSync("git", ["init", "-q", "-b", "feat/task-commits"], { cwd: f.root });
    execFileSync("git", ["config", "user.name", "Pi Test"], { cwd: f.root });
    execFileSync("git", ["config", "user.email", "pi@example.test"], { cwd: f.root });

    const listeners = [];
    const api = {
      on: (name, fn) => { if (name === "tool_call") listeners.push(fn); },
      events: { on: () => {} },
      registerTool: () => {},
    };
    harnessPolicy(api);
    harnessEntryGate(api);
    const runHooks = async (command) => {
      for (const listener of listeners) {
        const decision = await listener(
          { toolName: "bash", toolCallId: `call-${listeners.indexOf(listener)}`, input: { command } },
          parentCtx(f.root),
        );
        assert.notEqual(decision?.block, true, `${command}: ${decision?.reason ?? "blocked"}`);
      }
    };

    mkdirSync(join(f.root, "tests"), { recursive: true });
    writeFileSync(join(f.root, "tests", "app.test.mjs"), "// locked test\n");
    await runHooks("git add -- tests/app.test.mjs");
    execFileSync("git", ["add", "--", "tests/app.test.mjs"], { cwd: f.root });
    await runHooks('git commit -m "test(app): freeze locked test for task-1"');
    execFileSync("git", ["commit", "-q", "-m", "test(app): freeze locked test for task-1"], { cwd: f.root });

    mkdirSync(join(f.root, "src"), { recursive: true });
    writeFileSync(join(f.root, "src", "app.ts"), "export const ready = true;\n");
    await runHooks("git add -- src/app.ts");
    execFileSync("git", ["add", "--", "src/app.ts"], { cwd: f.root });
    await runHooks('git commit -m "feat(app): implement task-1"');
    execFileSync("git", ["commit", "-q", "-m", "feat(app): implement task-1"], { cwd: f.root });

    const subjects = execFileSync("git", ["log", "--format=%s", "--reverse"], { cwd: f.root, encoding: "utf8" }).trim().split("\n");
    assert.deepEqual(subjects, [
      "test(app): freeze locked test for task-1",
      "feat(app): implement task-1",
    ]);
    const residue = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: f.root,
      encoding: "utf8",
    }).trim().split("\n").filter(Boolean);
    assert.ok(residue.length > 0, "the runtime state fixture remains untracked");
    assert.ok(residue.every((line) => line.startsWith("?? .pi/harness/")), residue.join("\n"));
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
