/**
 * @description Locked tests for plan-write-gate (U1). Mirrors CC plan-write-gate cases.
 * #ac-u1.1 deny Write path oracle; #ac-u1.2 planner task may write; #ac-u1.3 forge via Write blocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { decide } from "./lib/plan-write-decide.mjs";

test("deny write to execution-plan.json (main loop)", () => {
  const p = { tool_input: { file_path: ".opencode/plans/foo/execution-plan.json" } };
  const r = decide(p);
  assert.equal(r.allow, false);
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /orchestrator must not author/);
});

test("allow planner task write to execution-plan.json", () => {
  const p = { agent_type: "planner", tool_input: { file_path: ".opencode/plans/foo/execution-plan.json" } };
  const r = decide(p);
  assert.equal(r.allow, true);
});

test("deny write to gate-state.json (basename rail)", () => {
  const p = { tool_input: { file_path: "any/gate-state.json" } };
  const r = decide(p);
  assert.equal(r.allow, false);
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /gate-state\/triage/);
});

test("deny write to triage.json under .state", () => {
  const p = { tool_input: { file_path: ".opencode/plans/.state/ses/triage.json" } };
  const r = decide(p);
  assert.equal(r.allow, false);
});

test("carve-out test fixtures pass", () => {
  const p = { tool_input: { file_path: "__fixtures__/gate-state.test.json" } };
  const r = decide(p);
  assert.equal(r.allow, true);
});
