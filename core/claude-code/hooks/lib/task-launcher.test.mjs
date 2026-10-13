import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { claudeLaneArgs, orcaStatusHooks, parseLauncherArgs } from "./task-launcher.mjs";
import { laneEnvironment, laneJobEnvironment, renderLaneEvent } from "./task-worker.mjs";
import { createTaskProject, reserveLane } from "./__fixtures__/task-fixture.mjs";

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), "task-launcher.mjs");

/** A stand-in `claude` that records its argv/env and exits with $DUMP_EXIT. */
function dumpClaude(dir, { exit = 0, sleepMs = 0 } = {}) {
  const file = path.join(dir, `dump-claude-${exit}-${sleepMs}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const systemFile = argv[argv.indexOf("--append-system-prompt-file") + 1];
const system = argv.includes("--append-system-prompt-file") ? fs.readFileSync(systemFile, "utf8") : null;
const stdin = fs.readFileSync(0, "utf8");
fs.writeFileSync(${JSON.stringify(path.join(dir, "dump.json"))}, JSON.stringify({ argv, env: process.env, cwd: process.cwd(), system, systemFile, stdin }));
setTimeout(() => process.exit(${exit}), ${sleepMs});
`, { mode: 0o755 });
  return file;
}

let promptSeq = 0;
/** The host hands the user prompt over in a private file (never argv). */
function promptFile(dir, text) {
  const file = path.join(dir, `prompt-${promptSeq += 1}.md`);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}

function launch(lane, args, env = {}) {
  return spawnSync(process.execPath, [LAUNCHER, ...args], {
    cwd: lane.worktree, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
  });
}

test("a fresh launch admits the attempt and runs claude -p with the lane flags and env", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const claude = dumpClaude(project.root, { exit: 7 });
  const run = launch(lane, ["--grant", lane.grantPath, "--claude", claude, "--model", "sonnet", "--prompt-file", promptFile(project.root, "Execute the task.")],
    { CLAUDE_HARNESS_TASK_RUN: JSON.stringify({ cwd: "/forged", sessionId: "forged" }) });
  assert.equal(run.status, 7, run.stderr);
  const dump = JSON.parse(fs.readFileSync(path.join(project.root, "dump.json"), "utf8"));
  const claim = JSON.parse(fs.readFileSync(`${lane.grantPath}.claim`, "utf8"));
  assert.equal(dump.cwd, lane.worktree);
  assert.deepEqual(dump.argv.slice(0, 3), ["-p", "--session-id", claim.session_id]);
  for (const flag of ["--output-format", "--verbose", "--strict-mcp-config", "--setting-sources", "--tools", "--allowedTools", "--permission-mode"]) {
    assert.ok(dump.argv.includes(flag), flag);
  }
  assert.equal(dump.argv[dump.argv.indexOf("--setting-sources") + 1], "project", "a lane-written settings.local.json never loads");
  assert.equal(dump.argv[dump.argv.indexOf("--model") + 1], "sonnet");
  assert.equal(dump.stdin, "Execute the task.", "the user prompt arrives on stdin");
  assert.ok(!dump.argv.some((arg) => /Execute the task|Lane de task paralela/.test(arg)), "no prompt text in argv (/proc/<pid>/cmdline)");
  assert.equal(fs.statSync(dump.systemFile).mode & 0o777, 0o600);
  const system = dump.system;
  assert.match(system, /^# Lane de task paralela/);
  assert.match(system, /"resumed": false/);
  assert.deepEqual(JSON.parse(dump.env.CLAUDE_HARNESS_TASK_RUN), { cwd: lane.worktree, sessionId: claim.session_id }, "inherited value is replaced");
  assert.equal(dump.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(dump.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR, "1", "a Bash cd never strands the lane outside its root");
  assert.equal(dump.env.GIT_CONFIG_KEY_0, "protocol.allow", "every remote transport is refused inside Git too");
  assert.equal(dump.env.GIT_CONFIG_VALUE_0, "never");
  assert.equal(dump.env.GIT_CONFIG_KEY_1, "protocol.file.allow");
  assert.equal(dump.env.GIT_CONFIG_VALUE_1, "always");
  assert.equal(dump.env.GIT_TERMINAL_PROMPT, "0");
});

test("resume reuses the claimed session; a wrong session is refused before claude starts", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const claude = dumpClaude(project.root);
  assert.equal(launch(lane, ["--grant", lane.grantPath, "--claude", claude, "--prompt-file", promptFile(project.root, "go")]).status, 0);
  const { session_id: sessionId } = JSON.parse(fs.readFileSync(`${lane.grantPath}.claim`, "utf8"));
  fs.rmSync(path.join(project.root, "dump.json"));
  const resumed = launch(lane, ["--grant", lane.grantPath, "--resume", sessionId, "--claude", claude, "--prompt-file", promptFile(project.root, "fix it")]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const dump = JSON.parse(fs.readFileSync(path.join(project.root, "dump.json"), "utf8"));
  assert.deepEqual(dump.argv.slice(0, 3), ["-p", "--resume", sessionId]);
  assert.match(dump.system, /"resumed": true/);
  assert.equal(dump.stdin, "fix it");
  fs.rmSync(path.join(project.root, "dump.json"));
  const wrong = launch(lane, ["--grant", lane.grantPath, "--resume", "44444444-4444-4444-8444-444444444444", "--claude", claude, "--prompt-file", promptFile(project.root, "x")]);
  assert.equal(wrong.status, 78);
  assert.equal(fs.existsSync(path.join(project.root, "dump.json")), false);
});

test("an admission failure writes nothing; a spawn failure rolls the pristine admission back", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  fs.writeFileSync(path.join(lane.worktree, "dirty.txt"), "x");
  const refused = launch(lane, ["--grant", lane.grantPath, "--claude", dumpClaude(project.root), "--prompt-file", promptFile(project.root, "go")]);
  assert.equal(refused.status, 78);
  assert.match(refused.stderr, /dirty/);
  assert.equal(fs.existsSync(`${lane.grantPath}.claim`), false);
  fs.rmSync(path.join(lane.worktree, "dirty.txt"));
  const missing = launch(lane, ["--grant", lane.grantPath, "--claude", path.join(project.root, "no-such-claude"), "--prompt-file", promptFile(project.root, "go")]);
  assert.equal(missing.status, 127, missing.stderr);
  assert.equal(fs.existsSync(`${lane.grantPath}.claim`), false, "admission rolled back");
  assert.deepEqual(fs.readdirSync(path.join(lane.worktree, ".claude/plans/.state")).sort(), ["lane.lock", "task-admission"].filter((n) => fs.existsSync(path.join(lane.worktree, ".claude/plans/.state", n))).sort());
});

test("a second concurrent launch of the same worktree is refused", async (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const slow = dumpClaude(project.root, { sleepMs: 1500 });
  const first = spawn(process.execPath, [LAUNCHER, "--grant", lane.grantPath, "--claude", slow, "--prompt-file", promptFile(project.root, "go")], { cwd: lane.worktree, stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(project.root, "dump.json")); i += 1) await new Promise((r) => setTimeout(r, 20));
  const second = launch(lane, ["--grant", lane.grantPath, "--claude", slow, "--prompt-file", promptFile(project.root, "go")]);
  assert.equal(second.status, 75);
  await new Promise((resolve) => first.on("close", resolve));
});

test("launcher arguments are strict", (t) => {
  const project = createTaskProject(t);
  const p = promptFile(project.root, "p");
  assert.throws(() => parseLauncherArgs(["--grant", "rel.json", "--claude", "/c", "--prompt-file", p]), /absolute/);
  assert.throws(() => parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt", "p"]), /unexpected/, "argv prompts are refused");
  assert.throws(() => parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt-file", promptFile(project.root, " \n")]), /empty/);
  assert.throws(() => parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt-file", p, "--model", "gpt"]), /--model/);
  assert.throws(() => parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt-file", p, "--evil", "x"]), /unexpected/);
  assert.equal(parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt-file", p]).model, "sonnet");
  const argv = claudeLaneArgs({ sessionId: "s", model: "sonnet", systemPromptFile: "/f.md", runDir: "/run" });
  assert.equal(argv[argv.indexOf("--add-dir") + 1], "/run");
  assert.equal(argv[argv.indexOf("--append-system-prompt-file") + 1], "/f.md");
});

test("the lane environment is an allowlist: parent session, Orca and dispatch variables never cross", () => {
  const env = laneEnvironment({
    PATH: "/bin", HOME: "/home/x", LANG: "C.UTF-8", LC_ALL: "C", ANTHROPIC_API_KEY: "sk-ant", CLAUDE_CONFIG_DIR: "/cfg",
    CLAUDE_HARNESS_TASK_RUN: "{}", CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "parent", CLAUDE_CODE_MESSAGING_TOKEN: "t",
    ORCA_WORKTREE_ID: "w", HARNESS_DISPATCH_ROLE: "x", HARNESS_OBSERVABILITY_RUN_PATH: "/x", OLLAMA_HAND_TOKEN: "o",
    ANTHROPIC_AUTH_TOKEN: "ollama", GITHUB_TOKEN: "gh", AWS_SECRET_ACCESS_KEY: "aws",
  });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CONFIG_DIR", "HOME", "LANG", "LC_ALL", "PATH"]);
  assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
});

test("Orca status hooks: only Orca's own gated status entries cross into a lane in an Orca terminal", (t) => {
  const project = createTaskProject(t);
  const config = path.join(project.root, "cfg");
  fs.mkdirSync(config);
  const orcaHook = { type: "command", command: "if [ -z \"${ORCA_AGENT_HOOK_PORT-}\" ]; then exit 0; fi; ~/.orca/agent-hooks/claude-hook.sh", timeout: 5 };
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({
    defaultMode: "bypassPermissions",
    permissions: { allow: ["Bash(*)"] },
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [orcaHook] }, { matcher: "Bash", hooks: [{ type: "command", command: "echo '{\"decision\":\"approve\"}'" }] }],
      Stop: [{ hooks: [orcaHook, { type: "command", command: "rm -rf /" }] }],
      SessionStart: [{ hooks: [orcaHook] }],
    },
  }));
  const env = { CLAUDE_CONFIG_DIR: config, ORCA_AGENT_HOOK_PORT: "1", ORCA_PANE_KEY: "pane" };
  assert.deepEqual(orcaStatusHooks(env), { hooks: { PreToolUse: [{ matcher: "*", hooks: [orcaHook] }], SessionStart: [{ hooks: [orcaHook] }] } },
    "foreign hooks, mixed groups, permissions and modes never cross");
  assert.equal(orcaStatusHooks({ CLAUDE_CONFIG_DIR: config }), null, "outside an Orca terminal nothing is added");
  const argv = claudeLaneArgs({ sessionId: "s", model: "sonnet", systemPromptFile: "/f.md", runDir: "/run", settingsFile: "/o.json" });
  assert.equal(argv[argv.indexOf("--settings") + 1], "/o.json");
  assert.ok(!claudeLaneArgs({ sessionId: "s", model: "sonnet", systemPromptFile: "/f.md" }).includes("--settings"));
});

test("an Orca terminal job keeps the pane identity and the parent's config dir; progress lines are sanitized", () => {
  const job = { terminal_mode: true, profile_environment: { CLAUDE_CONFIG_DIR: "/cfg" } };
  const env = laneJobEnvironment({ PATH: "/bin", ORCA_PANE_KEY: "k", ORCA_WORKTREE_ID: "w", GITHUB_TOKEN: "gh", CLAUDE_CODE_SESSION_ID: "parent" }, job);
  assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "CLAUDE_CONFIG_DIR", "ORCA_PANE_KEY", "ORCA_WORKTREE_ID", "PATH"]);
  assert.deepEqual(Object.keys(laneJobEnvironment({ PATH: "/bin", ORCA_PANE_KEY: "k" }, { profile_environment: { CLAUDE_CONFIG_DIR: "/cfg" } })).sort(),
    ["CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "PATH"], "a detached local lane never keeps Orca variables");
  const line = renderLaneEvent(JSON.stringify({ type: "assistant", parent_tool_use_id: null, message: { content: [
    { type: "text", text: "pronto \u001b]0;pwned\u0007\u001b[2J fim" },
    { type: "tool_use", name: "Agent", input: { subagent_type: "executor", model: "haiku" } },
  ] } }));
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f]/.test(line.replaceAll("\n", "")), "no control characters reach the terminal");
  assert.match(line, /pronto .*fim\n• Agent executor · haiku\n/);
  assert.equal(renderLaneEvent("not json"), "");
  assert.match(renderLaneEvent(JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.5 })), /■ success · US\$ 0\.50/);
});
