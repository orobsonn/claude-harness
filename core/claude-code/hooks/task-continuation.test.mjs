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
