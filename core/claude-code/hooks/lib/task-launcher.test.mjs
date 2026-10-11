import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { claudeLaneArgs, parseLauncherArgs } from "./task-launcher.mjs";
import { laneEnvironment } from "./task-worker.mjs";
import { createTaskProject, reserveLane } from "./__fixtures__/task-fixture.mjs";

const LAUNCHER = path.join(path.dirname(fileURLToPath(import.meta.url)), "task-launcher.mjs");

/** A stand-in `claude` that records its argv/env and exits with $DUMP_EXIT. */
function dumpClaude(dir, { exit = 0, sleepMs = 0 } = {}) {
  const file = path.join(dir, `dump-claude-${exit}-${sleepMs}.mjs`);
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(path.join(dir, "dump.json"))}, JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));
setTimeout(() => process.exit(${exit}), ${sleepMs});
`, { mode: 0o755 });
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
  const run = launch(lane, ["--grant", lane.grantPath, "--claude", claude, "--model", "sonnet", "--prompt", "Execute the task."],
    { CLAUDE_HARNESS_TASK_RUN: JSON.stringify({ cwd: "/forged", sessionId: "forged" }) });
  assert.equal(run.status, 7, run.stderr);
  const dump = JSON.parse(fs.readFileSync(path.join(project.root, "dump.json"), "utf8"));
  const claim = JSON.parse(fs.readFileSync(`${lane.grantPath}.claim`, "utf8"));
  assert.equal(dump.cwd, lane.worktree);
  assert.deepEqual(dump.argv.slice(0, 3), ["-p", "--session-id", claim.session_id]);
  for (const flag of ["--output-format", "--verbose", "--strict-mcp-config", "--setting-sources", "--tools", "--allowedTools", "--permission-mode"]) {
    assert.ok(dump.argv.includes(flag), flag);
  }
  assert.equal(dump.argv[dump.argv.indexOf("--setting-sources") + 1], "project,local");
  assert.equal(dump.argv[dump.argv.indexOf("--model") + 1], "sonnet");
  assert.equal(dump.argv.at(-1), "Execute the task.");
  const system = dump.argv[dump.argv.indexOf("--append-system-prompt") + 1];
  assert.match(system, /^# Lane de task paralela/);
  assert.match(system, /"resumed": false/);
  assert.deepEqual(JSON.parse(dump.env.CLAUDE_HARNESS_TASK_RUN), { cwd: lane.worktree, sessionId: claim.session_id }, "inherited value is replaced");
  assert.equal(dump.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
  assert.equal(dump.env.GIT_CONFIG_KEY_0, "url.harness-lane-push-disabled://.pushInsteadOf", "pushes are disabled inside Git too");
  assert.equal(dump.env.GIT_CONFIG_VALUE_0, "");
});

test("resume reuses the claimed session; a wrong session is refused before claude starts", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const claude = dumpClaude(project.root);
  assert.equal(launch(lane, ["--grant", lane.grantPath, "--claude", claude, "--prompt", "go"]).status, 0);
  const { session_id: sessionId } = JSON.parse(fs.readFileSync(`${lane.grantPath}.claim`, "utf8"));
  fs.rmSync(path.join(project.root, "dump.json"));
  const resumed = launch(lane, ["--grant", lane.grantPath, "--resume", sessionId, "--claude", claude, "--prompt", "fix it"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const dump = JSON.parse(fs.readFileSync(path.join(project.root, "dump.json"), "utf8"));
  assert.deepEqual(dump.argv.slice(0, 3), ["-p", "--resume", sessionId]);
  assert.match(dump.argv[dump.argv.indexOf("--append-system-prompt") + 1], /"resumed": true/);
  fs.rmSync(path.join(project.root, "dump.json"));
  const wrong = launch(lane, ["--grant", lane.grantPath, "--resume", "44444444-4444-4444-8444-444444444444", "--claude", claude, "--prompt", "x"]);
  assert.equal(wrong.status, 78);
  assert.equal(fs.existsSync(path.join(project.root, "dump.json")), false);
});

test("an admission failure writes nothing; a spawn failure rolls the pristine admission back", (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  fs.writeFileSync(path.join(lane.worktree, "dirty.txt"), "x");
  const refused = launch(lane, ["--grant", lane.grantPath, "--claude", dumpClaude(project.root), "--prompt", "go"]);
  assert.equal(refused.status, 78);
  assert.match(refused.stderr, /dirty/);
  assert.equal(fs.existsSync(`${lane.grantPath}.claim`), false);
  fs.rmSync(path.join(lane.worktree, "dirty.txt"));
  const missing = launch(lane, ["--grant", lane.grantPath, "--claude", path.join(project.root, "no-such-claude"), "--prompt", "go"]);
  assert.equal(missing.status, 127, missing.stderr);
  assert.equal(fs.existsSync(`${lane.grantPath}.claim`), false, "admission rolled back");
  assert.deepEqual(fs.readdirSync(path.join(lane.worktree, ".claude/plans/.state")).sort(), ["lane.lock", "task-admission"].filter((n) => fs.existsSync(path.join(lane.worktree, ".claude/plans/.state", n))).sort());
});

test("a second concurrent launch of the same worktree is refused", async (t) => {
  const project = createTaskProject(t);
  const lane = reserveLane(project, "task-a");
  const slow = dumpClaude(project.root, { sleepMs: 1500 });
  const first = spawn(process.execPath, [LAUNCHER, "--grant", lane.grantPath, "--claude", slow, "--prompt", "go"], { cwd: lane.worktree, stdio: "ignore" });
  for (let i = 0; i < 100 && !fs.existsSync(path.join(project.root, "dump.json")); i += 1) await new Promise((r) => setTimeout(r, 20));
  const second = launch(lane, ["--grant", lane.grantPath, "--claude", slow, "--prompt", "go"]);
  assert.equal(second.status, 75);
  await new Promise((resolve) => first.on("close", resolve));
});

test("launcher arguments are strict", () => {
  assert.throws(() => parseLauncherArgs(["--grant", "rel.json", "--claude", "/c", "--prompt", "p"]), /absolute/);
  assert.throws(() => parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt", "p", "--model", "gpt"]), /--model/);
  assert.throws(() => parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt", "p", "--evil", "x"]), /unexpected/);
  assert.equal(parseLauncherArgs(["--grant", "/g", "--claude", "/c", "--prompt", "p"]).model, "sonnet");
  assert.throws(() => claudeLaneArgs({ sessionId: "s", model: "sonnet", systemPrompt: "x".repeat(200_000), prompt: "p" }), /too large/);
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
