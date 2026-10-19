import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
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
  assert.match(decide(payload("Read", {}), { env, hookCwd: path.dirname(lane.worktree) }).reason, /hook cwd is outside the admitted task worktree/);
  // Claude Code's Bash keeps its cwd: after `cd src` the lane must not be stranded (real TUI lane).
  fs.mkdirSync(path.join(lane.worktree, "src", "a"), { recursive: true });
  assert.equal(decide(payload("Bash", { command: "pwd" }), { env, hookCwd: path.join(lane.worktree, "src", "a") }).deny, false, "a subdirectory of the worktree is the same lane");
  // A sibling whose name only extends the worktree's (worktree-other) is never the lane.
  const sibling = `${lane.worktree}-other`;
  fs.mkdirSync(sibling, { recursive: true });
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  assert.match(decide(payload("Read", {}), { env, hookCwd: sibling }).reason, /hook cwd is outside the admitted task worktree/);
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
  const runWrite = (extra) => run(payload("Write", { file_path: path.join(lane.runDir, "shared_context.md"), content: "x" }, extra));
  assert.equal(runWrite().deny, false, "the orchestrator writes its run buffers outside Git");
  assert.equal(runWrite({ agent_id: "a1", agent_type: "executor" }).deny, true, "hands never write the run buffers");
  assert.equal(write(".claude/plans/demo-feature/run/shared_context.md").deny, true, "nothing under .claude/ in the worktree");
  assert.equal(run(payload("Write", { file_path: path.join(lane.runDir, "..", "worktree", "src/a/x.mjs"), content: "x" })).deny, true, "no escape from the run dir");
  assert.equal(write("src/a/x.mjs").deny, true, "the orchestrator never writes product");
  assert.equal(write("src/a/x.mjs", { agent_id: "a1", agent_type: "executor" }).deny, false);
  assert.equal(write("src/b/x.mjs", { agent_id: "a1", agent_type: "executor" }).deny, true);
  assert.equal(write("test/task-a.test.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, false);
  assert.equal(write("src/a/x.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, false, "a NEW scaffold stub inside the scope");
  fs.mkdirSync(path.join(lane.worktree, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(lane.worktree, "src/a/x.mjs"), "export const x = 1;\n");
  assert.equal(write("src/a/x.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, false, "before fidelity it may rewrite its own untracked stub");
  git(lane.worktree, "add", "src/a/x.mjs");
  git(lane.worktree, "commit", "-qm", "product");
  assert.equal(write("src/a/x.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, true, "never an existing (tracked) product file");
  fs.writeFileSync(path.join(lane.worktree, "src/a/y.mjs"), "export const y = 1;\n");
  stampFidelity(lane);
  assert.equal(write("src/a/y.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, true, "after fidelity an untracked product file is the executor's");
  assert.equal(write("src/b/y.mjs", { agent_id: "a1", agent_type: "test-author" }).deny, true, "never outside the scope");
  assert.equal(run(payload("Write", { file_path: "/etc/passwd", content: "x" }, { agent_id: "a1", agent_type: "executor" })).deny, true);
  assert.equal(run(payload("Edit", { file_path: path.join(lane.worktree, ".claude/hooks/task-gate.mjs") }, { agent_id: "a", agent_type: "sniper" })).deny, true);
});

test("before fidelity, a test-author re-brief keeps its own new stub; a tracked product edit still blocks it", (t) => {
  const { run, payload, lane } = admittedLane(t);
  const testAuthor = () => run(payload("Agent", { subagent_type: "test-author", model: "sonnet", prompt: marker() }));
  fs.mkdirSync(path.join(lane.worktree, "src/a"), { recursive: true });
  fs.writeFileSync(path.join(lane.worktree, "src/a/index.mjs"), "export function a() { throw new Error(\"not implemented\"); }\n");
  assert.equal(testAuthor().deny, false, "the uncommitted stub is the test-author's own pre-fidelity output");
  const ledger = path.join(lane.worktree, ".claude/plans/.state", LANE, "task-ledger.jsonl");
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  fs.writeFileSync(ledger, `${JSON.stringify({ v: 1, event: "pre", tool_use_id: "toolu_s1", tool: "Agent", agent_id: null, subagent_type: "sniper" })}\n`);
  assert.match(testAuthor().reason, /Preserve the existing task implementation/, "after a sniper ran, untracked files are its product, not a stub");
  fs.rmSync(ledger);
  git(lane.worktree, "add", "src/a/index.mjs");
  git(lane.worktree, "commit", "-qm", "base");
  fs.writeFileSync(path.join(lane.worktree, "src/a/index.mjs"), "export const a = 2;\n");
  assert.match(testAuthor().reason, /Preserve the existing task implementation/, "a tracked product edit is never a stub");
});

test("a test-author repair or a discard with an uncommitted product delta is denied", (t) => {
  const { run, payload, lane } = admittedLane(t);
  stampFidelity(lane);
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
  // Registry-shaped receipts alone never open delivery: the gate runs the full integrated-evidence
  // check (inspection receipt, two-parent merge, changed paths, frozen blobs). The positive path with
  // real host receipts is covered end to end in task-e2e.test.mjs.
  assert.match(parent("Bash", { command: "git push" }).reason, /integrated evidence missing for demo-feature\/task-a/);
  tasks["task-b"].integration.result_sha256 = hashTaskReceipt({ forged: true });
  writeRegistry(project, tasks);
  assert.match(parent("Bash", { command: "gh pr create --fill" }).reason, /task-b has no valid integration receipt/);
  fs.writeFileSync(path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs/index.json"), "{corrupt");
  assert.match(parent("Bash", { command: "git push" }).reason, /cannot be read safely/);
});

test("parent gate: the Git-control acknowledgement is the operator's alone; an internal error fails closed for delivery", (t) => {
  const project = createTaskProject(t);
  writeRegistry(project, { "task-a": { task_id: "task-a", attempt_id: "x", status: "running" } });
  const parent = (tool_name, tool_input, deps = {}) => decide({ session_id: project.sessionId, tool_name, tool_input }, { env: {}, root: project.root, ...deps });
  for (const command of [
    "CLAUDE_HARNESS_ACCEPT_GIT_CONTROL_CHANGE=1 node .claude/hooks/tasks.mjs status --json '{}'",
    "export CLAUDE_HARNESS_ACCEPT_GIT_CONTROL_CHANGE=1",
  ]) assert.match(parent("Bash", { command }).reason, /only the operator sets it/, command);
  const runs = path.join(project.root, ".claude/plans/.state", project.sessionId, "task-runs");
  for (const command of [
    `echo '{}' > ${runs}/index.json`,
    "sed -i s/blocked/integrated/ .claude/plans/.state/x/task-runs/index.json",
    "python3 -c 'open(\".claude/plans/.state/x/task-runs/index.json\",\"w\")'",
  ]) assert.match(parent("Bash", { command }).reason, /host-owned/, command);
  assert.match(parent("Write", { file_path: path.join(runs, "index.json"), content: "{}" }).reason, /host-owned/);
  assert.equal(parent("Bash", { command: "node .claude/hooks/tasks.mjs status --json '{}'" }).deny, false, "the CLI is the way in");
  // A payload whose fields throw on access reaches the gate's error path.
  const boom = (field) => ({ get [field]() { throw new Error("boom"); } });
  assert.equal(parent("Agent", boom("subagent_type")).deny, true);
  assert.equal(parent("Bash", boom("command")).deny, true);
  assert.equal(parent("Read", boom("file_path")).deny, false, "reads stay usable");
});

test("parent gate: a project's own tasks.mjs, task-ledger mentions and harness sources are never caught (no registry)", (t) => {
  const project = createTaskProject(t);
  const parent = (command) => decide({ session_id: project.sessionId, tool_name: "Bash", tool_input: { command } }, { env: {}, root: project.root });
  for (const command of [
    "git add src/tasks.mjs",
    "node scripts/cron-tasks.mjs",
    "npx hardhat --config tasks.mjs",
    "cat .claude/hooks/task-ledger.mjs",
    'git commit -m "fix task-ledger flake"',
    "grep -rn task-admission docs/",
    "git add .claude/hooks/tasks.mjs",
    "git diff -- .claude/hooks/tasks.mjs",
    'git commit -m "bump .claude/hooks/tasks.mjs"',
    "grep -n node .claude/hooks/tasks.mjs",
    'npm test -- --grep "ACCEPT header" && echo GIT_CONTROL_CHAR',
    'git commit -m "docs: explain node .claude/hooks/tasks.mjs usage"',
  ]) assert.equal(parent(command).deny, false, command);
  for (const command of [
    "CLAUDE_CODE_SESSION_ID=x node .claude/hooks/tasks.mjs status",
    "cd /tmp && node /repo/.claude/hooks/tasks.mjs dispatch",
    "X=1 ./.claude/hooks/tasks.mjs status",
    // Obfuscations: quoting, repeated or `..` segments, shell -c, a split env name.
    "CLAUDE_CODE_SESSION_ID=other node .claude/hooks//tasks.mjs status --json '{}'",
    'CLAUDE_CODE_SESSION_ID=other node .claude/hooks/"tasks.mjs" status',
    "CLAUDE_CODE_SESSION_ID=other node .claude/hooks/../hooks/tasks.mjs status",
    "bash -c 'node .claude/hooks/tasks.mjs status'",
    `env CLAUDE_HARNESS_ACCEPT_GIT_CONTROL_CHANG""E=1 node .claude/hooks/tasks.mjs status --json '{}'`,
    `cat ${project.root}/.claude/plans/.state/${project.sessionId}/task-runs/index.json`,
    "rm .claude/plans/.state/x/task-admission/a.json",
  ]) assert.equal(parent(command).deny, true, command);
});

test("parent gate after a Bash cd: the project root comes from CLAUDE_PROJECT_DIR / Git, never the hook cwd", (t) => {
  const project = createTaskProject(t);
  writeRegistry(project, { "task-a": { task_id: "task-a", attempt_id: "x", status: "running" } });
  const sub = path.join(project.root, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  const run = (extraEnv) => spawnSync(process.execPath, [HOOK], {
    cwd: sub, encoding: "utf8",
    input: JSON.stringify({ session_id: project.sessionId, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push -u origin HEAD" } }),
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...extraEnv },
  });
  for (const [label, env] of [["CLAUDE_PROJECT_DIR", { CLAUDE_PROJECT_DIR: project.root }], ["git toplevel", {}]]) {
    const out = run(env);
    assert.equal(out.status, 0, label);
    assert.match(out.stdout, /"permissionDecision":"deny"/, `${label}: delivery stays gated from a subdirectory`);
  }
});

test("parent gate: a delivered parallel run (all integrated, HEAD on a remote branch) no longer pins the session", (t) => {
  const project = createTaskProject(t);
  const head = git(project.root, "rev-parse", "HEAD");
  writeRegistry(project, { "task-a": { task_id: "task-a", attempt_id: "x", status: "integrated", integration: { integrated_head: head } } });
  const parent = (tool_name, tool_input) => decide({ session_id: project.sessionId, tool_name, tool_input }, { env: {}, root: project.root });
  assert.equal(parent("Bash", { command: "node .claude/hooks/classify.mjs FULL next-feature" }).deny, true, "undelivered: classification stays fixed");
  const remote = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-remote-")));
  t.after(() => fs.rmSync(remote, { recursive: true, force: true }));
  git(remote, "init", "-q", "--bare");
  git(project.root, "remote", "add", "origin", remote);
  git(project.root, "push", "-q", "origin", "HEAD:refs/heads/feat");
  git(project.root, "fetch", "-q", "origin");
  assert.equal(parent("Bash", { command: "node .claude/hooks/classify.mjs FULL next-feature" }).deny, false, "delivered: a next feature can start");
  assert.equal(parent("Agent", { subagent_type: "executor", model: "haiku", prompt: "x" }).deny, false);
});
