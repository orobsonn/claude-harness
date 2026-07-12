/**
 * @description A3 locked tests — deterministic scope_paths write rail (#ac-3.1).
 *
 * An executor/sniper SUBAGENT write outside its dispatch's scope_paths/allowed_writes is DENIED by
 * plan-write-gate's PreToolUse rail. The active scope is sourced from a new `active-scope` marker
 * (mark.mjs) stamped into gate-state.active_dispatch by stamp-triage.
 *
 * Run with: node --test core/hooks/scope-rail.test.mjs
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide as planDecide } from "./plan-write-gate.mjs";
import { parseArgs, run } from "./mark.mjs";
import { handle as stampHandle } from "./stamp-triage.mjs";
import { readGateState } from "./lib/gate-lib.mjs";

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-rail-test-"));
  const savedCwd = process.cwd();
  try {
    process.chdir(tmpDir);
    fn();
  } finally {
    process.chdir(savedCwd);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** Builds a subagent Write payload (own agent_id ⇒ subagent context). */
function makeSubagentWrite(filePath, agentType, extra = {}) {
  return {
    session_id: "ses_scope",
    tool_name: "Write",
    agent_id: "ag_1",
    agent_type: agentType,
    tool_input: { file_path: filePath, content: "x" },
    ...extra,
  };
}

const EXECUTOR_SCOPE = {
  active_dispatch: {
    role: "executor",
    feature_id: "feat-a",
    task_id: "task-1",
    scope_paths: ["src/a.ts"],
    allowed_writes: ["docs/notes.md"],
  },
};

// ---------------------------------------------------------------------------
// #ac-3.1 — deny out-of-scope, allow in-scope, allow allowed_writes
// ---------------------------------------------------------------------------

test("#ac-3.1 executor subagent write OUTSIDE scope_paths → deny naming the path and the scope", () => {
  const payload = makeSubagentWrite("src/b.ts", "executor");
  const verdict = planDecide(payload, { readGateStateFn: () => EXECUTOR_SCOPE });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.hookSpecificOutput.permissionDecision, "deny");
  assert.ok(verdict.hookSpecificOutput.permissionDecisionReason.includes("src/b.ts"), "reason names the out-of-scope path");
  assert.ok(verdict.hookSpecificOutput.permissionDecisionReason.includes("src/a.ts"), "reason names the active scope");
});

test("#ac-3.1 executor subagent write INSIDE scope_paths → allow", () => {
  const payload = makeSubagentWrite("src/a.ts", "executor");
  const verdict = planDecide(payload, { readGateStateFn: () => EXECUTOR_SCOPE });
  assert.equal(verdict.allow, true);
});

test("#ac-3.1 executor subagent write to an allowed_writes entry → allow", () => {
  const payload = makeSubagentWrite("docs/notes.md", "executor");
  const verdict = planDecide(payload, { readGateStateFn: () => EXECUTOR_SCOPE });
  assert.equal(verdict.allow, true);
});

test("scope rail: a directory scope entry admits paths beneath it", () => {
  const dirScope = { active_dispatch: { role: "executor", feature_id: "f", task_id: "t", scope_paths: ["src/lib"], allowed_writes: [] } };
  assert.equal(planDecide(makeSubagentWrite("src/lib/deep/x.ts", "executor"), { readGateStateFn: () => dirScope }).allow, true);
  assert.equal(planDecide(makeSubagentWrite("src/other.ts", "executor"), { readGateStateFn: () => dirScope }).allow, false);
});

test("scope rail: a '..' traversal that escapes scope is denied (normalized before compare)", () => {
  const payload = makeSubagentWrite("src/a.ts/../../etc/passwd", "executor");
  const verdict = planDecide(payload, { readGateStateFn: () => EXECUTOR_SCOPE });
  assert.equal(verdict.allow, false, "a path that normalizes outside scope must be denied");
});

test("scope rail: sniper is subject to its own active_dispatch scope", () => {
  const sniperScope = { active_dispatch: { role: "sniper", feature_id: "f", task_id: "t", scope_paths: ["src/fix.ts"], allowed_writes: [] } };
  assert.equal(planDecide(makeSubagentWrite("src/fix.ts", "sniper"), { readGateStateFn: () => sniperScope }).allow, true);
  assert.equal(planDecide(makeSubagentWrite("src/elsewhere.ts", "sniper"), { readGateStateFn: () => sniperScope }).allow, false);
});

// ---------------------------------------------------------------------------
// fail-open + non-subject cases
// ---------------------------------------------------------------------------

test("fail-open: no active_dispatch → executor subagent write anywhere is allowed (rail off)", () => {
  const payload = makeSubagentWrite("src/anywhere.ts", "executor");
  const verdict = planDecide(payload, { readGateStateFn: () => ({}) });
  assert.equal(verdict.allow, true);
});

test("fail-open: active_dispatch role mismatches the acting role → allow (scope belongs to another dispatch)", () => {
  // active scope is for a sniper, but a subagent executor is writing → rail is off for this role.
  const sniperScope = { active_dispatch: { role: "sniper", feature_id: "f", task_id: "t", scope_paths: ["src/fix.ts"], allowed_writes: [] } };
  const verdict = planDecide(makeSubagentWrite("src/b.ts", "executor"), { readGateStateFn: () => sniperScope });
  assert.equal(verdict.allow, true);
});

test("non-hand subagent (planner) is NOT subject to the scope rail", () => {
  // A planner writing a non-plan path passes freely regardless of active_dispatch.
  const verdict = planDecide(makeSubagentWrite("src/b.ts", "planner"), { readGateStateFn: () => EXECUTOR_SCOPE });
  assert.equal(verdict.allow, true);
});

test("main loop (no agent_id) is NOT subject to the scope rail", () => {
  const payload = {
    session_id: "ses_scope",
    tool_name: "Write",
    agent_type: "executor",
    tool_input: { file_path: "src/b.ts", content: "x" },
  };
  const verdict = planDecide(payload, { readGateStateFn: () => EXECUTOR_SCOPE });
  assert.equal(verdict.allow, true);
});

test("scope rail never relaxes the state-file rail: an executor write to gate-state.json is still denied", () => {
  const payload = makeSubagentWrite("src/a.ts/gate-state.json", "executor"); // in-scope-looking basename homonym
  const verdict = planDecide(payload, { readGateStateFn: () => EXECUTOR_SCOPE });
  assert.equal(verdict.allow, false, "the basename state-file rail must fire regardless of scope");
  assert.ok(verdict.hookSpecificOutput.permissionDecisionReason.includes("gate-state"), "the deny is the state-file rail, not the scope rail");
});

// ---------------------------------------------------------------------------
// mark.mjs active-scope — parse + validate
// ---------------------------------------------------------------------------

test("mark active-scope: valid args parse and normalize the path lists", () => {
  const argv = ["node", "mark.mjs", "active-scope", "--feature-id", "feat-a", "--task-id", "task-1", "--role", "executor", "--scope-paths", "src/a.ts,src/b.ts", "--allowed-writes", "docs/x.md"];
  const parsed = parseArgs(argv);
  assert.ok(parsed, "active-scope must parse");
  const result = run(parsed);
  assert.equal(result.success, true);
  assert.deepEqual(result.output.scope_paths, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(result.output.allowed_writes, ["docs/x.md"]);
  assert.equal(result.output.role, "executor");
});

test("mark active-scope: allowed-writes is optional (defaults to [])", () => {
  const argv = ["node", "mark.mjs", "active-scope", "--feature-id", "feat-a", "--task-id", "task-1", "--role", "sniper", "--scope-paths", "src/a.ts"];
  const result = run(parseArgs(argv));
  assert.equal(result.success, true);
  assert.deepEqual(result.output.allowed_writes, []);
});

test("mark active-scope: a scope path containing '..' is rejected", () => {
  const argv = ["node", "mark.mjs", "active-scope", "--feature-id", "feat-a", "--task-id", "task-1", "--role", "executor", "--scope-paths", "src/../../etc"];
  const result = run(parseArgs(argv));
  assert.equal(result.success, false);
  assert.ok(/scope-paths/.test(result.error), "error must name scope-paths");
});

test("mark active-scope: an absolute scope path is rejected", () => {
  const argv = ["node", "mark.mjs", "active-scope", "--feature-id", "feat-a", "--task-id", "task-1", "--role", "executor", "--scope-paths", "/etc/passwd"];
  const result = run(parseArgs(argv));
  assert.equal(result.success, false);
});

test("mark active-scope: an invalid role is rejected", () => {
  const argv = ["node", "mark.mjs", "active-scope", "--feature-id", "feat-a", "--task-id", "task-1", "--role", "planner", "--scope-paths", "src/a.ts"];
  const result = run(parseArgs(argv));
  assert.equal(result.success, false);
  assert.ok(/role/.test(result.error), "error must name role");
});

test("mark active-scope: missing --scope-paths fails to parse", () => {
  const argv = ["node", "mark.mjs", "active-scope", "--feature-id", "feat-a", "--task-id", "task-1", "--role", "executor"];
  assert.equal(parseArgs(argv), null);
});

// ---------------------------------------------------------------------------
// stamp-triage active-scope handler — writes gate-state.active_dispatch (last-write-wins)
// ---------------------------------------------------------------------------

test("stamp active-scope: writes active_dispatch; a later dispatch overwrites it (last-write-wins)", () => {
  withTempDir(() => {
    const sid = "ses_ad";
    const mk = (taskId, role, scope) => ({
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: `node .claude/hooks/mark.mjs active-scope --feature-id feat-a --task-id ${taskId} --role ${role} --scope-paths ${scope}` },
      tool_response: JSON.stringify({ marker: "active-scope", feature_id: "feat-a", task_id: taskId, role, scope_paths: [scope], allowed_writes: [] }),
    });
    stampHandle(mk("task-1", "executor", "src/a.ts"));
    let state = readGateState(sid);
    assert.equal(state.active_dispatch.task_id, "task-1");
    assert.deepEqual(state.active_dispatch.scope_paths, ["src/a.ts"]);

    stampHandle(mk("task-2", "sniper", "src/b.ts"));
    state = readGateState(sid);
    assert.equal(state.active_dispatch.task_id, "task-2", "later dispatch overwrites (last-write-wins)");
    assert.equal(state.active_dispatch.role, "sniper");
    assert.deepEqual(state.active_dispatch.scope_paths, ["src/b.ts"]);
  });
});

test("stamp active-scope: a scope entry with '..' in the marker stdout is rejected (no write)", () => {
  withTempDir(() => {
    const sid = "ses_ad_bad";
    const payload = {
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: "node .claude/hooks/mark.mjs active-scope --feature-id feat-a --task-id task-1 --role executor --scope-paths x" },
      tool_response: JSON.stringify({ marker: "active-scope", feature_id: "feat-a", task_id: "task-1", role: "executor", scope_paths: ["../etc"], allowed_writes: [] }),
    };
    stampHandle(payload);
    const state = readGateState(sid);
    assert.equal(state.active_dispatch, undefined, "a traversal scope entry must not be persisted");
  });
});

// Adversarial (F1): a SUBAGENT-origin active-scope marker must NEVER stamp active_dispatch — only
// the main-loop orchestrator (no agent_id) sets the active scope. Otherwise a straying executor/
// sniper hand (which shares the session_id) could re-stamp a WIDER scope mid-flight and write outside
// its dispatch scope. The top-level agent_id guard in stamp-triage.decide() closes this.
test("stamp active-scope: a SUBAGENT-origin marker (own agent_id) is ignored — no active_dispatch write", () => {
  withTempDir(() => {
    const sid = "ses_ad_sub";
    // First, the orchestrator legitimately narrows the scope to src/a.ts.
    stampHandle({
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: "node .claude/hooks/mark.mjs active-scope --feature-id feat-a --task-id task-1 --role executor --scope-paths src/a.ts" },
      tool_response: JSON.stringify({ marker: "active-scope", feature_id: "feat-a", task_id: "task-1", role: "executor", scope_paths: ["src/a.ts"], allowed_writes: [] }),
    });
    assert.deepEqual(readGateState(sid).active_dispatch.scope_paths, ["src/a.ts"]);

    // Now the executor SUBAGENT tries to widen its own scope to the whole `src` tree.
    stampHandle({
      agent_id: "ag_exec",
      agent_type: "executor",
      session_id: sid,
      tool_name: "Bash",
      tool_input: { command: "node .claude/hooks/mark.mjs active-scope --feature-id feat-a --task-id task-1 --role executor --scope-paths src" },
      tool_response: JSON.stringify({ marker: "active-scope", feature_id: "feat-a", task_id: "task-1", role: "executor", scope_paths: ["src"], allowed_writes: [] }),
    });
    assert.deepEqual(
      readGateState(sid).active_dispatch.scope_paths,
      ["src/a.ts"],
      "a subagent-origin active-scope marker must NOT widen the scope — the orchestrator's narrow scope stands",
    );
  });
});
