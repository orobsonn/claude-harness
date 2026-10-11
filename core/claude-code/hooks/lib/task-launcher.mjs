#!/usr/bin/env node
/**
 * @description Lane launcher — the command the task supervisor runs inside the lane worktree.
 *
 *   node task-launcher.mjs --grant <grant.json> [--resume <laneSession>] --claude <bin>
 *        --model <haiku|sonnet|opus> --prompt <text>
 *
 * Fresh launch: read-only preflight + `wx` claim + seeded lane state (admitTaskRun), then a NEW
 * top-level `claude -p --session-id <uuid>`. Resume: revalidate the existing binding and
 * `claude -p --resume <laneSession>` in the same worktree. The lane system prompt is the task
 * runtime (never the global runtime) plus the `[HARNESS_TASK_RUN]` envelope. Flags follow the
 * spike (docs/claude-parallel-tasks-spike-2026-10-10.md §1). stdout is the native stream-json the
 * supervisor records as events.jsonl. A spawn failure rolls back only a pristine fresh admission.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { acquireLock, releaseLock } from "../../../shared/lib/file-lock.mjs";
import { admitTaskRun, readTaskRunBinding, rollbackTaskAdmission, taskRunPrompt } from "./task-admission.mjs";
import { TASK_RUN_ENV, stateRoot } from "./task-paths.mjs";

const RUNTIME_PROMPT = fileURLToPath(new URL("../../skills/orchestrating-delivery/references/task-runtime.md", import.meta.url));
export const LANE_TOOLS = "Bash,Read,Write,Edit,Glob,Grep,Agent";
const LANE_MODELS = new Set(["haiku", "sonnet", "opus"]);
const MAX_SYSTEM_PROMPT_BYTES = 120 * 1024;
/**
 * Defense in depth below the lane gate's Bash policy (which a shell can obfuscate): an empty
 * `pushInsteadOf` rewrites EVERY push URL to an unsupported transport, so a push that slips past
 * the gate still fails inside Git. Fetch and local commits are unaffected.
 */
export const LANE_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "url.harness-lane-push-disabled://.pushInsteadOf",
  GIT_CONFIG_VALUE_0: "",
});

export function parseLauncherArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--grant", "--resume", "--claude", "--model", "--prompt"].includes(flag) || value === undefined || Object.hasOwn(args, flag.slice(2))) {
      throw new Error(`unexpected launcher argument ${JSON.stringify(flag)}`);
    }
    args[flag.slice(2)] = value;
  }
  if (!args.grant || !args.claude || !args.prompt) throw new Error("--grant, --claude and --prompt are required");
  if (!path.isAbsolute(args.grant) || !path.isAbsolute(args.claude)) throw new Error("--grant and --claude must be absolute paths");
  args.model ??= "sonnet";
  if (!LANE_MODELS.has(args.model)) throw new Error("--model must be haiku, sonnet or opus");
  return args;
}

/** argv for the lane's `claude -p`, exactly the combination proven in the spike. */
export function claudeLaneArgs({ sessionId, resume, model, systemPrompt, prompt }) {
  if (Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_BYTES) throw new Error("lane system prompt is too large");
  return [
    "-p",
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    "--output-format", "stream-json",
    "--verbose",
    "--model", model,
    "--permission-mode", "acceptEdits",
    "--allowedTools", LANE_TOOLS,
    "--tools", LANE_TOOLS,
    "--setting-sources", "project,local",
    "--strict-mcp-config",
    "--append-system-prompt", systemPrompt,
    prompt,
  ];
}

async function main() {
  delete process.env[TASK_RUN_ENV];
  const args = parseLauncherArgs(process.argv.slice(2));
  const cwd = fs.realpathSync(process.cwd());
  const lockTarget = path.join(stateRoot(cwd), "lane");
  const lock = acquireLock(lockTarget, { timeoutMs: 5 });
  if (!lock.ok) {
    process.stderr.write("[task-launcher] another launch of this task worktree is active\n");
    process.exit(75);
  }
  const release = () => { try { releaseLock(lockTarget, lock.token); } catch { /* stale lock recovers after 30 s */ } };
  let admission;
  let sessionId;
  const resume = typeof args.resume === "string";
  if (resume) {
    sessionId = args.resume;
    admission = readTaskRunBinding(cwd, sessionId);
    if (admission.ok && path.resolve(args.grant) !== admission.grantPath) admission = { ok: false, reason: "[task-run] resume grant mismatch" };
  } else {
    sessionId = randomUUID();
    admission = admitTaskRun(args.grant, { cwd, sessionId });
  }
  if (!admission.ok) {
    release();
    process.stderr.write(`${admission.reason}\n`);
    process.exit(78);
  }
  let argv;
  try {
    argv = claudeLaneArgs({
      sessionId,
      resume,
      model: args.model,
      systemPrompt: taskRunPrompt(fs.readFileSync(RUNTIME_PROMPT, "utf8"), admission, { resumed: resume }),
      prompt: args.prompt,
    });
  } catch (error) {
    if (!resume) rollbackTaskAdmission(admission);
    release();
    process.stderr.write(`[task-launcher] ${error.message}\n`);
    process.exit(78);
  }
  const child = spawn(args.claude, argv, {
    cwd,
    env: { ...process.env, ...LANE_GIT_ENV, [TASK_RUN_ENV]: JSON.stringify({ cwd, sessionId }), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  let spawned = false;
  const forward = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => forward(signal));
  child.on("spawn", () => { spawned = true; });
  child.on("error", (error) => {
    if (!spawned) {
      if (!resume) rollbackTaskAdmission(admission);
      release();
      process.stderr.write(`[task-launcher] could not start claude: ${error.message}\n`);
      process.exit(127);
    }
  });
  child.on("close", (code, signal) => {
    release();
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectCli()) {
  main().catch((error) => {
    process.stderr.write(`[task-launcher] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(70);
  });
}
