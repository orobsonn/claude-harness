import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { decide, INSTRUCTIONS } from "./task-continuation.mjs";
import { createTaskProject, git } from "./lib/__fixtures__/task-fixture.mjs";

function parent(t) {
  const project = createTaskProject(t);
  const registryFile = path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json");
  const write = (tasks, extra = {}) => {
    fs.mkdirSync(path.dirname(registryFile), { recursive: true });
    fs.writeFileSync(registryFile, JSON.stringify({ version: 1, parent_session_id: project.sessionId, feature_id: project.featureId, tasks, ...extra }));
  };
  const stop = () => decide({ session_id: project.sessionId, hook_event_name: "Stop" }, { env: {}, cwd: project.root });
  const prompt = (text) => decide({ session_id: project.sessionId, hook_event_name: "UserPromptSubmit", prompt: text }, { env: {}, cwd: project.root });
  return { project, write, stop, prompt };
}

test("parent: unsettled tasks are continued once per state; an operator stop pauses it", (t) => {
  const { write, stop, prompt } = parent(t);
  assert.deepEqual(stop(), {}, "no registry, no continuation");
  write({ "task-a": { task_id: "task-a", status: "running" } });
  const first = stop();
  assert.equal(first.output.decision, "block");
  assert.ok(first.output.reason.endsWith(INSTRUCTIONS.tasks));
  assert.deepEqual(stop(), {}, "the same state never buys another continuation");
  write({ "task-a": { task_id: "task-a", status: "ready", result: { child_head: "a".repeat(40) } } });
  prompt("pare por favor");
  assert.deepEqual(stop(), {}, "paused by the operator");
  prompt("continue");
  assert.equal(stop().output.decision, "block", "a new prompt lifts the pause");
});

test("parent: integrated but undelivered goes to final review; a remote branch with HEAD ends it", (t) => {
  const { project, write, stop } = parent(t);
  const head = git(project.root, "rev-parse", "HEAD");
  write({ "task-a": { task_id: "task-a", status: "integrated", integration: { integrated_head: head } } });
  const pending = stop();
  assert.ok(pending.output.reason.endsWith(INSTRUCTIONS["final-review"]));
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-remote-")));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  git(remote, "init", "-q", "--bare");
  git(project.root, "remote", "add", "origin", remote);
  git(project.root, "push", "-q", "origin", "HEAD:refs/heads/feat");
  git(project.root, "fetch", "-q", "origin");
  write({ "task-a": { task_id: "task-a", status: "integrated", integration: { integrated_head: head } } }, { revision: 2 });
  assert.deepEqual(stop(), {}, "a draft PR boundary (HEAD on a remote branch) needs no continuation");
  write({ "task-a": { task_id: "task-a", status: "integrated", integration: { integrated_head: head } } }, { correction_barrier: { task_id: "task-a" } });
  assert.equal(stop().output.decision, "block", "an open correction is never delivered");
});

test("a lane hook never acts for another session or a malformed binding", (t) => {
  const { project } = parent(t);
  const env = { CLAUDE_HARNESS_TASK_RUN: JSON.stringify({ cwd: project.root, sessionId: "33333333-3333-4333-8333-333333333333" }) };
  assert.deepEqual(decide({ session_id: project.sessionId, hook_event_name: "Stop" }, { env, cwd: project.root }), {});
  assert.deepEqual(decide({ session_id: project.sessionId, hook_event_name: "Stop" }, { env: { CLAUDE_HARNESS_TASK_RUN: "{" }, cwd: project.root }), {});
  assert.deepEqual(decide(null, { env: {}, cwd: project.root }), {});
});

import { laneContinuation } from "./task-continuation.mjs";

function laneLedger(t, { mode = "FULL" } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-cont-lane-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "i");
  const head = git(root, "rev-parse", "HEAD");
  const session = "55555555-5555-4555-8555-555555555555";
  const file = path.join(root, ".claude/plans/.state", session, "task-ledger.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let n = 0;
  const call = (record) => {
    n += 1;
    const base = { v: 1, at: new Date(Date.UTC(2026, 9, 13, 0, 0, n)).toISOString(), session_id: session, agent_id: null, agent_type: null, tool_use_id: `toolu_${n}`, head, dirty: [], merging: false };
    fs.appendFileSync(file, `${JSON.stringify({ ...base, ...record, event: "pre" })}\n${JSON.stringify({ ...base, ...record, event: "post", status: "ok" })}\n`);
  };
  const mark = (action) => call({ tool: "Bash", command: `node .claude/hooks/mark.mjs ${action} --feature-id demo --task-id task-a` });
  const agent = (subagent_type, report_tail = "") => call({ tool: "Agent", subagent_type, model: "sonnet", report_tail });
  const binding = { sessionId: session, grant: { feature_id: "demo", task_id: "task-a", mode }, plan: null, task: null };
  return { root, call, mark, agent, binding };
}

test("lane: a BLOCKED lane that makes no progress gets the hint once, whatever it runs meanwhile", (t) => {
  const lane = laneLedger(t);
  lane.agent("test-author");
  const first = laneContinuation(lane.root, lane.binding);
  assert.equal(first.stage, "task-implementation");
  lane.call({ tool: "Bash", command: "git status" });
  lane.call({ tool: "Bash", command: "git status" });
  assert.equal(laneContinuation(lane.root, lane.binding).key, first.key, "diagnostic calls are not progress");
});

test("lane (FULL): a negative or missing eye never closes the lane; a positive one after the capture does", (t) => {
  const lane = laneLedger(t);
  lane.agent("executor", "## Status: DONE");
  lane.mark("capture-verified");
  lane.agent("compliance", "## Veredito: fail");
  assert.equal(laneContinuation(lane.root, lane.binding)?.stage, "task-reviews", "a negative compliance keeps the lane working");
  lane.agent("compliance", "## Veredito: pass");
  assert.equal(laneContinuation(lane.root, lane.binding), null, "positive at the final HEAD closes the lane");
});

test("a casual session (no task registry) never writes continuation state, even on a stop request", (t) => {
  const project = createTaskProject(t);
  const dir = path.join(project.root, ".claude/plans/.state", project.sessionId);
  decide({ session_id: project.sessionId, hook_event_name: "UserPromptSubmit", prompt: "pare tudo" }, { env: {}, cwd: project.root });
  assert.equal(fs.existsSync(path.join(dir, "continuation.json")), false);
});


test("a clean native BLOCKED author does not reopen a captured reviewed lane", t => {
  const lane = laneLedger(t);
  lane.agent("executor", "## Status: DONE"); lane.mark("capture-verified");
  lane.agent("compliance", "## Veredito: pass");
  assert.equal(laneContinuation(lane.root, lane.binding), null);
  lane.call({ tool: "Agent", subagent_type: "test-author", agent_status: "completed", report_tail: "## Status: BLOCKED" });
  assert.equal(laneContinuation(lane.root, lane.binding), null, "unchanged clean refusal is not a new writer");
  lane.call({ tool: "Agent", subagent_type: "executor", agent_status: "completed", report_tail: "## Status: BLOCKED" });
  assert.equal(laneContinuation(lane.root, lane.binding), null, "an unchanged implementation refusal is not a new producer or writer");
  lane.call({ tool: "Agent", subagent_type: "test-author", agent_status: "completed", report_tail: "## Status: BLOCKED", dirty: ["test/changed.test.mjs"] });
  assert.equal(laneContinuation(lane.root, lane.binding).stage, "task-implementation", "a dirty refusal remains a writing boundary");
});
