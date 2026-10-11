import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { handle, parsePlanReviewReport, readPlanApproval } from "./task-plan-review.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "task-plan-review.mjs");
const SESSION = "6bd2720d-eb12-4f3d-a880-09c01c15c147";
const FEATURE = "demo-feature";

function project(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "task-plan-review-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, ".claude/plans/.state", SESSION), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude/plans", FEATURE), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude/plans/.state", SESSION, "triage.json"), JSON.stringify({ session_id: SESSION, mode: "FULL", feature_id: FEATURE }));
  fs.writeFileSync(path.join(root, ".claude/plans", FEATURE, "execution-plan.json"), '{"plan":1}');
  fs.writeFileSync(path.join(root, ".claude/plans", FEATURE, "spec.md"), "# spec\n");
  return root;
}

/** Payload shapes captured from claude 2.1.296 (spike rodada 2). */
const pre = (extra = {}) => ({
  session_id: SESSION, cwd: "/x", hook_event_name: "PreToolUse", tool_name: "Agent", tool_use_id: "toolu_1",
  tool_input: { description: "review", prompt: "review the plan", subagent_type: "plan-reviewer", model: "opus" }, ...extra,
});
const report = (verdict, extra = "") => `Resumo\n\n\`\`\`json\n${JSON.stringify({ verdict, findings: [] })}\n\`\`\`\n${extra}`;
const post = (text, response = {}, extra = {}) => ({
  ...pre(), hook_event_name: "PostToolUse",
  tool_response: { status: "completed", agentId: "ac1afc2ab7637c1e7", agentType: "plan-reviewer", content: [{ type: "text", text }], ...response },
  ...extra,
});

test("a foreground APPROVE over unchanged artifacts becomes host evidence bound to their hashes", (t) => {
  const root = project(t);
  assert.equal(readPlanApproval({ root, sessionId: SESSION, featureId: FEATURE }).ok, false);
  assert.equal(handle(pre(), { root }).action, "captured");
  const { evidence } = handle(post(report("APPROVE")), { root });
  assert.equal(evidence.verdict, "APPROVE");
  assert.equal(evidence.status, "completed");
  assert.equal(evidence.dispatch_call_id, "toolu_1");
  assert.equal(evidence.agent_id, "ac1afc2ab7637c1e7");
  const approval = readPlanApproval({ root, sessionId: SESSION, featureId: FEATURE });
  assert.equal(approval.ok, true, approval.reason);
  assert.equal(approval.plan_sha256, evidence.plan_sha256);
  // Any later plan or spec change invalidates the approval.
  fs.writeFileSync(path.join(root, ".claude/plans", FEATURE, "execution-plan.json"), '{"plan":2}');
  assert.match(readPlanApproval({ root, sessionId: SESSION, featureId: FEATURE }).reason, /current execution-plan\.json/);
});

test("a plan edited while the reviewer ran is not approved", (t) => {
  const root = project(t);
  handle(pre(), { root });
  fs.writeFileSync(path.join(root, ".claude/plans", FEATURE, "spec.md"), "# changed\n");
  const { evidence } = handle(post(report("APPROVE")), { root });
  assert.equal(evidence.status, "invalid");
  assert.match(evidence.reason, /changed while the plan-reviewer ran/);
  assert.equal(readPlanApproval({ root, sessionId: SESSION, featureId: FEATURE }).ok, false);
});

test("a later REVISE, a non-canonical report or an async launch replace an older APPROVE", (t) => {
  const root = project(t);
  handle(pre(), { root });
  handle(post(report("APPROVE")), { root });
  assert.equal(readPlanApproval({ root, sessionId: SESSION, featureId: FEATURE }).ok, true);
  for (const [label, payload] of [
    ["revise", post(report("REVISE"), {}, { tool_use_id: "toolu_2" })],
    ["two reports", post(report("APPROVE") + report("APPROVE"), {}, { tool_use_id: "toolu_3" })],
    ["plaintext", post("APPROVE", {}, { tool_use_id: "toolu_4" })],
    ["async", post(report("APPROVE"), { status: "async_launched", isAsync: true }, { tool_use_id: "toolu_5" })],
  ]) {
    handle(pre({ tool_use_id: payload.tool_use_id }), { root });
    handle(payload, { root });
    assert.equal(readPlanApproval({ root, sessionId: SESSION, featureId: FEATURE }).ok, false, label);
    handle(pre(), { root });
    handle(post(report("APPROVE")), { root });
  }
});

test("a completion without its dispatch capture, a subagent call or another role records nothing valid", (t) => {
  const root = project(t);
  assert.equal(handle(post(report("APPROVE")), { root }).evidence.status, "invalid", "no PreToolUse capture");
  assert.equal(handle({ ...post(report("APPROVE")), agent_id: "nested" }, { root }).action, "none");
  assert.equal(handle(post(report("APPROVE"), {}, { tool_input: { subagent_type: "adversary" } }), { root }).action, "none");
  assert.equal(handle(post(report("APPROVE"), {}, { session_id: "../evil" }), { root }).action, "none");
});

test("report parsing requires exactly one canonical JSON block", () => {
  assert.equal(parsePlanReviewReport(report("APPROVE")).verdict, "APPROVE");
  assert.equal(parsePlanReviewReport("```json\n{\"verdict\":\"APPROVE\"}\n```"), null, "findings[] required");
  assert.equal(parsePlanReviewReport("```json\n{\"verdict\":\"MAYBE\",\"findings\":[]}\n```"), null);
  assert.equal(parsePlanReviewReport("```json\nnot json\n```"), null);
  assert.equal(parsePlanReviewReport(`${report("APPROVE")}\n\`\`\`json\n{"note":1}\n\`\`\``).verdict, "APPROVE", "non-report JSON blocks are ignored");
});

test("the CLI is fail-open and records evidence from stdin", (t) => {
  const root = project(t);
  const run = (payload) => spawnSync(process.execPath, [HOOK], { cwd: root, input: typeof payload === "string" ? payload : JSON.stringify(payload), encoding: "utf8" });
  assert.equal(run("not json").status, 0);
  assert.equal(run(pre()).status, 0);
  const done = run(post(report("APPROVE")));
  assert.equal(done.status, 0);
  assert.equal(done.stdout, "");
  assert.equal(readPlanApproval({ root, sessionId: SESSION, featureId: FEATURE }).ok, true);
});
