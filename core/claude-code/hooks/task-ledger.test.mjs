import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { handle, parseExitCode } from "./task-ledger.mjs";
import { admitTaskRun } from "./lib/task-admission.mjs";
import { createTaskProject, git, reserveLane } from "./lib/__fixtures__/task-fixture.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "task-ledger.mjs");
const LANE = "33333333-3333-4333-8333-333333333333";

function lane(t) {
  const project = createTaskProject(t);
  const reserved = reserveLane(project, "task-a");
  assert.equal(admitTaskRun(reserved.grantPath, { cwd: reserved.worktree, sessionId: LANE }).ok, true);
  const env = { CLAUDE_HARNESS_TASK_RUN: JSON.stringify({ cwd: reserved.worktree, sessionId: LANE }) };
  const ledger = path.join(reserved.worktree, ".claude/plans/.state", LANE, "task-ledger.jsonl");
  const read = () => fs.readFileSync(ledger, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { ...reserved, env, ledger, read };
}

const bashPayload = (event, command, extra = {}) => ({
  session_id: LANE, cwd: "/x", hook_event_name: event, tool_name: "Bash", tool_input: { command, description: "d" }, tool_use_id: "toolu_bash", ...extra,
});

test("a commit is identified by HEAD moving between the pre and post records", (t) => {
  const l = lane(t);
  const before = git(l.worktree, "rev-parse", "HEAD");
  fs.mkdirSync(path.join(l.worktree, "test"), { recursive: true });
  fs.writeFileSync(path.join(l.worktree, "test/task-a.test.mjs"), "test\n");
  const pre = handle(bashPayload("PreToolUse", "git add test && git commit -m freeze"), { env: l.env, cwd: l.worktree, now: "t1" });
  assert.equal(pre.head, before);
  assert.deepEqual(pre.dirty, ["test/task-a.test.mjs"]);
  git(l.worktree, "add", "test");
  git(l.worktree, "commit", "-qm", "freeze");
  const post = handle(bashPayload("PostToolUse", "git add test && git commit -m freeze", { tool_response: { stdout: "[x abc] freeze" } }), { env: l.env, cwd: l.worktree, now: "t2" });
  assert.notEqual(post.head, before);
  assert.deepEqual(post.dirty, []);
  assert.equal(post.status, "ok");
  assert.equal(post.exit_code, 0);
  assert.deepEqual(l.read().map((r) => [r.event, r.tool, r.tool_use_id]), [["pre", "Bash", "toolu_bash"], ["post", "Bash", "toolu_bash"]]);
  assert.equal(fs.statSync(l.ledger).mode & 0o777, 0o600);
});

test("a failed Bash records the exit code from Claude Code's failure text", (t) => {
  const l = lane(t);
  const record = handle(bashPayload("PostToolUseFailure", "exit 3", { error: "Exit code 3\nls: cannot access", is_interrupt: false }), { env: l.env, cwd: l.worktree });
  assert.equal(record.status, "error");
  assert.equal(record.exit_code, 3);
  assert.equal(parseExitCode("no prefix"), null);
});

test("Agent records carry role, model, prompt digest, native id and async flag", (t) => {
  const l = lane(t);
  const input = { subagent_type: "executor", model: "haiku", prompt: "[HARNESS_TASK_CONTEXT]{\"task_id\":\"task-a\"}[/HARNESS_TASK_CONTEXT]" };
  const pre = handle({ session_id: LANE, hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: input, tool_use_id: "toolu_a" }, { env: l.env, cwd: l.worktree });
  assert.equal(pre.subagent_type, "executor");
  assert.match(pre.prompt_sha256, /^[a-f0-9]{64}$/);
  const post = handle({ session_id: LANE, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: input, tool_use_id: "toolu_a",
    tool_response: { status: "completed", agentId: "ac1afc2ab7637c1e7", agentType: "executor" } }, { env: l.env, cwd: l.worktree });
  assert.equal(post.agent_status, "completed");
  assert.equal(post.native_agent_id, "ac1afc2ab7637c1e7");
  assert.equal(post.is_async, false);
  const inner = handle(bashPayload("PreToolUse", "ls", { agent_id: "ac1afc2ab7637c1e7", agent_type: "executor", tool_use_id: "toolu_inner" }), { env: l.env, cwd: l.worktree });
  assert.equal(inner.agent_id, "ac1afc2ab7637c1e7");
  const stop = handle({ session_id: LANE, hook_event_name: "SubagentStop", agent_id: "ac1afc2ab7637c1e7", agent_type: "executor", stop_hook_active: false }, { env: l.env, cwd: l.worktree });
  assert.equal(stop.event, "subagent_stop");
});

test("the ledger is inert outside the admitted lane", (t) => {
  const l = lane(t);
  assert.equal(handle(bashPayload("PreToolUse", "ls"), { env: {}, cwd: l.worktree }), null);
  assert.equal(handle({ ...bashPayload("PreToolUse", "ls"), session_id: "other" }, { env: l.env, cwd: l.worktree }), null);
  assert.equal(handle(bashPayload("PreToolUse", "ls"), { env: { CLAUDE_HARNESS_TASK_RUN: "{" }, cwd: l.worktree }), null);
  assert.equal(handle(bashPayload("PreToolUse", "ls"), { env: l.env, cwd: path.dirname(l.worktree) }), null);
  assert.equal(handle({ ...bashPayload("PreToolUse", "x"), tool_name: "Read" }, { env: l.env, cwd: l.worktree }), null);
  assert.equal(fs.existsSync(l.ledger), false);
});

test("the CLI appends from stdin and never prints", (t) => {
  const l = lane(t);
  const run = spawnSync(process.execPath, [HOOK], { cwd: l.worktree, input: JSON.stringify(bashPayload("PreToolUse", "ls")), encoding: "utf8", env: { PATH: process.env.PATH, ...l.env } });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, "");
  assert.equal(l.read().length, 1);
  assert.equal(spawnSync(process.execPath, [HOOK], { cwd: l.worktree, input: "garbage", encoding: "utf8", env: { PATH: process.env.PATH, ...l.env } }).status, 0);
});
