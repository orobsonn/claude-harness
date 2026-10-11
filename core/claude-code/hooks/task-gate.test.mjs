import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { decide } from "./task-gate.mjs";
import { admitTaskRun } from "./lib/task-admission.mjs";
import { hashTaskReceipt } from "../../shared/lib/task-contract.mjs";
import { createTaskProject, git, reserveLane } from "./lib/__fixtures__/task-fixture.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "task-gate.mjs");
const LANE = "33333333-3333-4333-8333-333333333333";
const marker = (taskId = "task-a") => `[HARNESS_TASK_CONTEXT]{"task_id":"${taskId}"}[/HARNESS_TASK_CONTEXT]\nbrief`;

function admittedLane(t, options = {}) {
  const project = createTaskProject(t, options);
  const lane = reserveLane(project, "task-a");
  const admitted = admitTaskRun(lane.grantPath, { cwd: lane.worktree, sessionId: LANE });
  assert.equal(admitted.ok, true, admitted.reason);
  const env = { CLAUDE_HARNESS_TASK_RUN: JSON.stringify({ cwd: lane.worktree, sessionId: LANE }) };
  /** PreToolUse payload in the shape claude 2.1.296 sends (spike hooks2.log). */
  const payload = (tool_name, tool_input, extra = {}) => ({
    session_id: LANE, transcript_path: "/x.jsonl", cwd: lane.worktree, prompt_id: "p", permission_mode: "acceptEdits",
    effort: { level: "medium" }, hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_x", ...extra,
  });
  const run = (p) => decide(p, { env, hookCwd: lane.worktree });
  return { project, lane, env, payload, run };
}

test("without the host env the gate is inert for an ordinary session", (t) => {
  const project = createTaskProject(t);
  const verdict = decide({ session_id: project.sessionId, tool_name: "Bash", tool_input: { command: "git push" } }, { env: {}, root: project.root });
  assert.equal(verdict.deny, false);
  assert.equal(decide({ session_id: "x", tool_name: "Agent", tool_input: { subagent_type: "executor" } }, { env: {}, root: project.root }).deny, false);
});

test("a malformed env or an identity mismatch denies every tool", (t) => {
  const { payload, lane } = admittedLane(t);
  for (const raw of ["not json", "{}", JSON.stringify({ cwd: "relative", sessionId: LANE }), JSON.stringify({ cwd: lane.worktree, sessionId: LANE, extra: 1 })]) {
    const verdict = decide(payload("Read", { file_path: "x" }), { env: { CLAUDE_HARNESS_TASK_RUN: raw }, hookCwd: lane.worktree });
    assert.equal(verdict.deny, true, raw);
  }
  const env = { CLAUDE_HARNESS_TASK_RUN: JSON.stringify({ cwd: lane.worktree, sessionId: LANE }) };
  assert.match(decide({ ...payload("Read", {}), session_id: "other-session" }, { env, hookCwd: lane.worktree }).reason, /session differs/);
  assert.match(decide(payload("Read", {}), { env, hookCwd: path.dirname(lane.worktree) }).reason, /hook cwd differs/);
  assert.equal(decide(undefined, { env, hookCwd: lane.worktree }).deny, true);
});

test("a changed grant, claim, parent plan or parent spec denies every tool", (t) => {
  const { run, payload, lane, project } = admittedLane(t);
  assert.equal(run(payload("Read", { file_path: "src/README.md" })).deny, false);
  const claim = `${lane.grantPath}.claim`;
  for (const [file, change] of [
    [lane.grantPath, () => fs.appendFileSync(lane.grantPath, " ")],
    [claim, () => fs.writeFileSync(claim, JSON.stringify({ session_id: "another", grant_sha256: "0".repeat(64) }))],
    [path.join(project.root, ".claude/plans", project.featureId, "execution-plan.json"), (f) => fs.appendFileSync(f, " ")],
    [path.join(project.root, ".claude/plans", project.featureId, "spec.md"), (f) => fs.appendFileSync(f, " ")],
  ]) {
    const before = fs.readFileSync(file);
    change(file);
    assert.equal(run(payload("Read", { file_path: "src/README.md" })).deny, true, file);
    fs.writeFileSync(file, before);
  }
  assert.equal(run(payload("Read", { file_path: "src/README.md" })).deny, false);
});

test("lane Bash: coordination, ceremony, delivery, integration and amend are denied; merge-base only alone", (t) => {
  const { run, payload } = admittedLane(t);
  const bash = (command) => run(payload("Bash", { command, description: "x" }));
  for (const command of [
    "node .claude/hooks/tasks.mjs status", "node .claude/hooks/classify.mjs FULL demo", "git push", "git pull",
    "git merge main", "git rebase main", "git tag v1", "git commit --amend -m x", "gh pr create", "npm run deploy",
    "git merge-base A B && git merge X",
    "echo x > .claude/plans/demo-feature/execution-plan.json",
  ]) {
    assert.equal(bash(command).deny, true, command);
  }
  assert.equal(bash("git merge-base --is-ancestor HEAD HEAD").deny, false);
  assert.equal(bash("node --test test/task-a.test.mjs").deny, false);
  assert.equal(run(payload("Bash", { command: "sleep 60", run_in_background: true })).deny, true);
  assert.equal(bash("node .claude/hooks/mark.mjs fidelity-pass --feature-id demo-feature --task-id task-a").deny, false);
  assert.equal(bash("node .claude/hooks/mark.mjs fidelity-pass --feature-id demo-feature --task-id task-b").deny, true);
  assert.equal(bash("node .claude/hooks/mark.mjs brainstorm-done --feature-id demo-feature").deny, true);
});

function stampFidelity(lane, entry = "demo-feature/task-a@abc") {
  const file = path.join(lane.worktree, ".claude/plans/.state", LANE, "gate-state.json");
  const state = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...state, fidelity_pass: [entry] }));
}

test("the executor needs this task's own fidelity_pass unless the task has no tests", (t) => {
  const { run, payload, lane } = admittedLane(t);
  const executor = () => run(payload("Agent", { subagent_type: "executor", model: "haiku", prompt: marker() }));
  assert.match(executor().reason, /needs this task's fidelity first/);
  stampFidelity(lane, "demo-feature/task-b@abc");
  assert.equal(executor().deny, true, "another task's fidelity does not count");
  stampFidelity(lane);
  assert.equal(executor().deny, false);
  assert.equal(run(payload("Agent", { subagent_type: "sniper", model: "haiku", prompt: marker() })).deny, false, "the sniper is not fidelity-gated");
});

test("a no_tests task dispatches its executor without fidelity", (t) => {
  const tasks = [{ id: "task-a", spec: "docs", severity: "low", complexity: "low", scope_paths: ["docs/a.md"],
    resolved_judgments: { k: "v" }, criterion_refs: ["#ac-1.1"], locked_tests: [], no_tests: true,
    adversarial: { enabled: false }, depends_on: [] }];
  const { run, payload } = admittedLane(t, { tasks });
  assert.equal(run(payload("Agent", { subagent_type: "executor", model: "haiku", prompt: marker() })).deny, false);
});

test("lane Agent: roles, exact marker, foreground and the literal model route", (t) => {
  const { run, payload, lane } = admittedLane(t);
  stampFidelity(lane);
  const agent = (input, extra) => run(payload("Agent", { description: "d", ...input }, extra));
  assert.equal(agent({ subagent_type: "executor", model: "haiku", prompt: marker() }).deny, false);
  assert.equal(agent({ subagent_type: "test-author", model: "sonnet", prompt: marker() }).deny, false);
  assert.equal(agent({ subagent_type: "compliance", model: "sonnet", prompt: `[HARNESS_TASK_FIDELITY]\n${marker()}` }).deny, false);
  for (const [label, input, extra] of [
    ["planner", { subagent_type: "planner", model: "opus", prompt: marker() }],
    ["shipper", { subagent_type: "shipper", model: "sonnet", prompt: marker() }],
    ["general", { subagent_type: "general-purpose", model: "sonnet", prompt: marker() }],
    ["no marker", { subagent_type: "executor", model: "haiku", prompt: "brief" }],
    ["other task", { subagent_type: "executor", model: "haiku", prompt: marker("task-b") }],
    ["final review", { subagent_type: "compliance", model: "sonnet", prompt: `${marker()}\n[HARNESS_FINAL_REVIEW]` }],
    ["background", { subagent_type: "executor", model: "haiku", prompt: marker(), run_in_background: true }],
    ["wrong model", { subagent_type: "executor", model: "sonnet", prompt: marker() }],
    ["missing model", { subagent_type: "compliance", prompt: marker() }],
    ["wrong rung agent", { subagent_type: "executor-high", model: "sonnet", prompt: marker() }],
    ["fidelity on adversary", { subagent_type: "adversary", model: "sonnet", prompt: `[HARNESS_TASK_FIDELITY]\n${marker()}` }],
    ["nested", { subagent_type: "executor", model: "haiku", prompt: marker() }, { agent_id: "a1", agent_type: "sniper" }],
  ]) {
    assert.equal(agent(input, extra).deny, true, label);
  }
});

test("lane writes: orchestrator only run buffers; hands only their authorized paths", (t) => {
  const { run, payload, lane } = admittedLane(t);
  const write = (file, extra) => run(payload("Write", { file_path: path.join(lane.worktree, file), content: "x" }, extra));
  assert.equal(write(".claude/plans/demo-feature/run/shared_context.md").deny, false);
  assert.equal(write("src/a/x.mjs").deny, true, "the orchestrator never writes product");
  assert.equal(write("src/a/x.mjs", { agent_id: "a1", agent_type: "executor" }).deny, false);
  assert.equal(write("src/b/x.mjs", { agent_id: "a1", agent_type: "executor" }).deny, true);
  assert.equal(write("test/task-a.test.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, false);
  assert.equal(write("src/a/x.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, true);
  assert.equal(run(payload("Write", { file_path: "/etc/passwd", content: "x" }, { agent_id: "a1", agent_type: "executor" })).deny, true);
  assert.equal(run(payload("Edit", { file_path: path.join(lane.worktree, ".claude/hooks/task-gate.mjs") }, { agent_id: "a", agent_type: "sniper" })).deny, true);
});

test("a test-author repair or a discard with an uncommitted product delta is denied", (t) => {
  const { run, payload, lane } = admittedLane(t);
  fs.mkdirSync(path.join(lane.worktree, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(lane.worktree, "src/a/impl.mjs"), "export const x = 1;\n");
  assert.match(run(payload("Agent", { subagent_type: "test-author", model: "sonnet", prompt: marker() })).reason, /Preserve the existing task implementation/);
  assert.equal(run(payload("Bash", { command: "git stash push --include-untracked" })).deny, true);
  assert.equal(run(payload("Bash", { command: "git checkout -- src/a" })).deny, true);
  assert.equal(run(payload("Bash", { command: "git restore --staged -- src/a/impl.mjs" })).deny, false, "unstaging keeps bytes");
  fs.writeFileSync(path.join(lane.worktree, "test-note.txt"), "x");
  git(lane.worktree, "add", "src/a/impl.mjs");
  git(lane.worktree, "commit", "-qm", "checkpoint");
  assert.equal(run(payload("Agent", { subagent_type: "test-author", model: "sonnet", prompt: marker() })).deny, false);
  assert.equal(run(payload("Bash", { command: "git checkout -- test-note.txt" })).deny, false, "out-of-scope cleanup stays allowed");
});

test("the CLI emits the PreToolUse deny shape and fails closed in a lane", (t) => {
  const { payload, lane, env } = admittedLane(t);
  const run = (input, extraEnv = env) => spawnSync(process.execPath, [HOOK], {
    cwd: lane.worktree, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
  });
  const denied = run(payload("Bash", { command: "git push" }));
  assert.equal(denied.status, 0);
  const output = JSON.parse(denied.stdout);
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny");
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /cannot integrate, deliver/);
  assert.equal(run(payload("Bash", { command: "git status" })).stdout, "");
  assert.equal(JSON.parse(run("garbage").stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.equal(run("garbage", {}).stdout, "", "outside a lane an unreadable payload stays fail-open");
});

function writeRegistry(project, tasks) {
  const file = path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const planSha = hashTaskReceipt("p");
  fs.writeFileSync(file, JSON.stringify({ version: 1, parent_session_id: project.sessionId, feature_id: project.featureId, plan_sha256: planSha, spec_sha256: planSha, tasks }));
  return { file, planSha };
}

test("parent: the task CLI must be a single pure command", (t) => {
  const project = createTaskProject(t);
  const bash = (command) => decide({ session_id: project.sessionId, tool_name: "Bash", tool_input: { command } }, { env: {}, root: project.root });
  assert.equal(bash("node .claude/hooks/tasks.mjs status").deny, false);
  assert.equal(bash(`node .claude/hooks/tasks.mjs dispatch --json '{"task_ids":["task-a"]}'`).deny, false);
  assert.equal(bash("node .claude/hooks/tasks.mjs wait --json-file .claude/plans/demo-feature/run/wait.json").deny, false);
  for (const command of [
    "CLAUDE_CODE_SESSION_ID=evil node .claude/hooks/tasks.mjs status",
    "env CLAUDE_CODE_SESSION_ID=evil node .claude/hooks/tasks.mjs status",
    "cd /tmp && node .claude/hooks/tasks.mjs status",
    "node .claude/hooks/tasks.mjs status > out.json",
    "node .claude/hooks/tasks.mjs status; git push",
    "node .claude/hooks/tasks.mjs nuke",
  ]) {
    assert.equal(bash(command).deny, true, command);
  }
});

test("parent with admitted tasks: no hands, frozen plan/spec/classify, delivery needs every integration receipt", (t) => {
  const project = createTaskProject(t);
  const parent = (tool_name, tool_input, extra = {}) => decide({ session_id: project.sessionId, tool_name, tool_input, ...extra }, { env: {}, root: project.root });
  writeRegistry(project, { "task-a": { task_id: "task-a", attempt_id: "x", status: "running" } });
  assert.equal(parent("Agent", { subagent_type: "executor", model: "haiku" }).deny, true);
  assert.equal(parent("Agent", { subagent_type: "sniper-high" }).deny, true);
  assert.equal(parent("Agent", { subagent_type: "planner" }).deny, true);
  assert.equal(parent("Agent", { subagent_type: "plan-reviewer" }).deny, true);
  assert.equal(parent("Agent", { subagent_type: "adversary", model: "opus" }).deny, false, "final review eyes stay allowed");
  assert.equal(parent("Bash", { command: "node .claude/hooks/classify.mjs FULL x" }).deny, true);
  assert.equal(parent("Write", { file_path: path.join(project.root, ".claude/plans", project.featureId, "spec.md") }).deny, true);
  assert.match(parent("Bash", { command: "git push -u origin HEAD" }).reason, /task-a is running/);
  assert.equal(parent("Bash", { command: "git push" }, { agent_id: "s1", agent_type: "shipper" }).deny, true, "a shipper subagent's push is gated too");
  assert.equal(parent("Agent", { subagent_type: "shipper" }).deny, true);
  assert.equal(parent("Bash", { command: "git status" }).deny, false);

  const head = git(project.root, "rev-parse", "HEAD");
  const result = { child_head: head, session_id: "s" };
  const { planSha } = writeRegistry(project, {});
  const tasks = {};
  for (const id of ["task-a", "task-b", "task-c"]) {
    tasks[id] = { task_id: id, attempt_id: `att-${id}`, status: "integrated", result, integration: {
      written_by: "host-task-integration", task_id: id, attempt_id: `att-${id}`, feature_id: project.featureId,
      plan_sha256: planSha, spec_sha256: planSha, child_head: head, integrated_head: head, result_sha256: hashTaskReceipt(result) } };
  }
  writeRegistry(project, tasks);
  assert.equal(parent("Bash", { command: "git push" }).deny, false);
  tasks["task-b"].integration.result_sha256 = hashTaskReceipt({ forged: true });
  writeRegistry(project, tasks);
  assert.match(parent("Bash", { command: "gh pr create --fill" }).reason, /task-b has no valid integration receipt/);
  fs.writeFileSync(path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json"), "{corrupt");
  assert.match(parent("Bash", { command: "git push" }).reason, /cannot be read safely/);
});
