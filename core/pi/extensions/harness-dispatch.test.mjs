import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import harnessDispatch from "./harness-dispatch.ts";

function handler() {
  const registered = new Map();
  harnessDispatch({ on: (name, fn) => registered.set(name, fn) });
  return registered.get("tool_call");
}
function ctx({ hasUI = true, child = false, mode } = {}) {
  return {
    cwd: "/missing-discussion-project",
    hasUI,
    sessionManager: { getSessionId: () => "ses-discussion", getHeader: () => child ? { parentSession: "parent" } : {} },
    ...(mode ? { mode } : {}),
  };
}
const args = { subagent_type: "harness-discussion-adversary", model: "openai-codex/gpt-5.6-sol", thinking: "medium", prompt: "critique" };

test("discussion dispatch is local parent foreground and fixed Sol/medium", () => {
  assert.equal(handler()({ toolName: "subagent", input: args }, ctx()), undefined);
  assert.match(handler()({ toolName: "subagent", input: args }, ctx({ hasUI: false })).reason, /discussion-local-ui-required/);
  assert.match(handler()({ toolName: "subagent", input: args }, ctx({ child: true })).reason, /discussion-parent-required/);
  assert.match(handler()({ toolName: "subagent", input: { ...args, resume: "x" } }, ctx()).reason, /resume-disabled/);
  assert.match(handler()({ toolName: "subagent", input: { ...args, run_in_background: true } }, ctx()).reason, /background-disabled/);
});

test("discussion dispatch denies a project shadow and an active delivery ceremony", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-discussion-dispatch-"));
  try {
    mkdirSync(join(root, ".pi", "agents"), { recursive: true });
    writeFileSync(join(root, ".pi", "agents", "harness-discussion-adversary.md"), "shadow");
    assert.match(handler()({ toolName: "subagent", input: args }, { ...ctx(), cwd: root }).reason, /shadowed-role/);
    rmSync(join(root, ".pi", "agents"), { recursive: true, force: true });
    mkdirSync(join(root, ".pi", "harness", "state", "ses-discussion"), { recursive: true });
    writeFileSync(join(root, ".pi", "harness", "state", "ses-discussion", "gate-state.json"), JSON.stringify({ mode: "FULL" }));
    assert.match(handler()({ toolName: "subagent", input: args }, { ...ctx(), cwd: root }).reason, /discussion-active-ceremony/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("discussion refuses unreadable ceremony state or a missing session identity", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-discussion-unreadable-"));
  try {
    const stateDir = join(root, ".pi/harness/state/ses-discussion");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "gate-state.json"), "{broken");
    const blocked = handler()({ toolName: "subagent", input: args }, { ...ctx(), cwd: root });
    assert.equal(blocked?.block, true);
    assert.match(blocked.reason, /discussion-state-unreadable/);
    const unidentified = { ...ctx(), sessionManager: { getSessionId: () => null, getHeader: () => ({}) } };
    assert.equal(handler()({ toolName: "subagent", input: args }, unidentified)?.block, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
