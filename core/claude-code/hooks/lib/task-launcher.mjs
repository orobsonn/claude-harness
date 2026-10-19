#!/usr/bin/env node
/**
 * @description Lane launcher — the command the task supervisor runs inside the lane worktree.
 *
 *   node task-launcher.mjs --grant <grant.json> [--resume <laneSession>] --claude <bin>
 *        --model <haiku|sonnet|opus> --prompt-file <0600 file written by the host>
 *        [--presentation json|tui]
 *
 * Fresh launch: read-only preflight + `wx` claim + seeded lane state (admitTaskRun), then a NEW
 * top-level `claude -p --session-id <uuid>`. Resume: revalidate the existing binding and
 * `claude -p --resume <laneSession>` in the same worktree. The lane system prompt is the task
 * runtime (never the global runtime) plus the `[HARNESS_TASK_RUN]` envelope. Flags follow the
 * spike (docs/claude-parallel-tasks-spike-2026-10-10.md §1). stdout is the native stream-json the
 * supervisor records as events.jsonl. A spawn failure rolls back only a pristine fresh admission.
 *
 * `--presentation tui` (an Orca terminal, as Pi's TUI lanes): an interactive `claude` on the
 * terminal instead of `-p` stream-json. The host instruction joins the system prompt file and the
 * positional prompt is a fixed line, so no task text reaches argv; the lane hooks record the native
 * evidence from the transcript and end the session at the end of the turn (spike §15).
 */
import fs from "node:fs";
import os from "node:os";
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
 * Git hygiene for the lane (NOT a security boundary — a same-user shell can unset env): every
 * remote transport is refused (`protocol.allow=never`, which a per-remote pushurl cannot bypass,
 * unlike pushInsteadOf), credentials and prompts are disabled. Local commits and the file
 * protocol are unaffected. The lane gate's Bash policy and the host inspection stay the controls.
 */
export const LANE_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: "4",
  GIT_CONFIG_KEY_0: "protocol.allow",
  GIT_CONFIG_VALUE_0: "never",
  GIT_CONFIG_KEY_1: "protocol.file.allow",
  GIT_CONFIG_VALUE_1: "always",
  GIT_CONFIG_KEY_2: "credential.helper",
  GIT_CONFIG_VALUE_2: "",
  GIT_CONFIG_KEY_3: "core.fsmonitor",
  GIT_CONFIG_VALUE_3: "false",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "/bin/false",
  GIT_SSH_COMMAND: "/bin/false",
});

export function parseLauncherArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!["--grant", "--resume", "--claude", "--model", "--prompt-file", "--presentation"].includes(flag) || value === undefined || Object.hasOwn(args, flag.slice(2))) {
      throw new Error(`unexpected launcher argument ${JSON.stringify(flag)}`);
    }
    args[flag.slice(2)] = value;
  }
  if (!args.grant || !args.claude || !args["prompt-file"]) throw new Error("--grant, --claude and --prompt-file are required");
  if (!path.isAbsolute(args.grant) || !path.isAbsolute(args.claude) || !path.isAbsolute(args["prompt-file"])) {
    throw new Error("--grant, --claude and --prompt-file must be absolute paths");
  }
  args.prompt = fs.readFileSync(args["prompt-file"], "utf8");
  if (!args.prompt.trim()) throw new Error("the launch prompt is empty");
  args.presentation ??= "json";
  if (!["json", "tui"].includes(args.presentation)) throw new Error("--presentation must be json or tui");
  args.model ??= "sonnet";
  if (!LANE_MODELS.has(args.model)) throw new Error("--model must be haiku, sonnet or opus");
  return args;
}

/**
 * argv for the lane's `claude -p` (the combination proven in the spike). The system prompt goes
 * through a 0600 file and the user prompt through stdin, so neither is visible in /proc/<pid>/cmdline.
 * Only the project settings load: a lane-written settings.local.json can never switch hooks off.
 */
/**
 * Orca's agent-status hooks, copied from the user's settings, for a lane running in an Orca terminal
 * (the worker keeps `ORCA_*` only there). A lane loads project settings only, so without this Orca
 * would not see the lane as an agent. Only entries whose every command is Orca's own status hook
 * (gated on ORCA_AGENT_HOOK_PORT, spooling to ~/.orca/agent-hooks) are kept; they print `{}` and
 * never decide. `--settings` hooks load beside the project ones (spike §14). Null when absent.
 */
export function orcaStatusHooks(env = process.env) {
  if (!env.ORCA_AGENT_HOOK_PORT || !env.ORCA_PANE_KEY) return null;
  const base = env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(env.HOME || os.homedir(), ".claude");
  let settings;
  try { settings = JSON.parse(fs.readFileSync(path.join(base, "settings.json"), "utf8")); } catch { return null; }
  const isOrcaHook = (hook) => hook?.type === "command" && typeof hook.command === "string" &&
    hook.command.includes("ORCA_AGENT_HOOK_PORT") && hook.command.includes("agent-hooks/claude-hook.sh");
  const hooks = {};
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.filter((group) => Array.isArray(group?.hooks) && group.hooks.length > 0 && group.hooks.every(isOrcaHook))
      .map((group) => ({ ...(group.matcher === undefined ? {} : { matcher: group.matcher }), hooks: group.hooks.map(({ type, command, timeout }) => ({ type, command, ...(timeout ? { timeout } : {}) })) }));
    if (kept.length) hooks[event] = kept;
  }
  return Object.keys(hooks).length ? { hooks } : null;
}

export const TUI_START_PROMPT = "Execute a task admitida conforme o envelope [HARNESS_TASK_RUN] e a instrução do host no system prompt.";

export function claudeLaneArgs({ sessionId, resume, model, systemPromptFile, runDir, settingsFile, presentation = "json" }) {
  const tui = presentation === "tui";
  return [
    ...(tui ? [] : ["-p"]),
    ...(resume ? ["--resume", sessionId] : ["--session-id", sessionId]),
    ...(tui ? [] : ["--output-format", "stream-json", "--verbose"]),
    "--model", model,
    "--permission-mode", "acceptEdits",
    "--allowedTools", LANE_TOOLS,
    "--tools", LANE_TOOLS,
    ...(runDir ? ["--add-dir", runDir] : []),
    "--setting-sources", "project",
    "--strict-mcp-config",
    "--append-system-prompt-file", systemPromptFile,
    ...(settingsFile ? ["--settings", settingsFile] : []),
    ...(tui ? [TUI_START_PROMPT] : []),
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
  let systemPromptFile;
  let settingsFile;
  try {
    const lanePrompt = taskRunPrompt(fs.readFileSync(RUNTIME_PROMPT, "utf8"), admission, { resumed: resume });
    // A TUI has no stdin prompt: the host instruction travels in the private system prompt file.
    const systemPrompt = args.presentation === "tui" ? `${lanePrompt}\n\n[HARNESS_HOST_INSTRUCTION]\n${args.prompt.trim()}\n[/HARNESS_HOST_INSTRUCTION]` : lanePrompt;
    if (Buffer.byteLength(systemPrompt, "utf8") > MAX_SYSTEM_PROMPT_BYTES) throw new Error("lane system prompt is too large");
    // Host-owned file outside the session state dir (rollback inspects that dir), rewritten per launch.
    const promptsDir = path.join(stateRoot(cwd), "lane-prompts");
    fs.mkdirSync(promptsDir, { recursive: true, mode: 0o700 });
    systemPromptFile = path.join(promptsDir, `${sessionId}.md`);
    fs.rmSync(systemPromptFile, { force: true });
    fs.writeFileSync(systemPromptFile, systemPrompt, { flag: "wx", mode: 0o600 });
    const orca = orcaStatusHooks(process.env);
    if (orca) {
      settingsFile = path.join(promptsDir, `${sessionId}.orca-settings.json`);
      fs.rmSync(settingsFile, { force: true });
      fs.writeFileSync(settingsFile, JSON.stringify(orca), { flag: "wx", mode: 0o600 });
    }
    argv = claudeLaneArgs({ sessionId, resume, model: args.model, systemPromptFile, runDir: admission.grant.run_dir, settingsFile, presentation: args.presentation });
  } catch (error) {
    if (!resume) rollbackTaskAdmission(admission);
    release();
    process.stderr.write(`[task-launcher] ${error.message}\n`);
    process.exit(78);
  }
  const child = spawn(args.claude, argv, {
    cwd,
    env: { ...process.env, ...LANE_GIT_ENV, [TASK_RUN_ENV]: JSON.stringify({ cwd, sessionId }), CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      // The lane's Bash returns to the worktree root after every command (a `cd` never strands it).
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1" },
    stdio: args.presentation === "tui" ? "inherit" : ["pipe", "inherit", "inherit"],
  });
  if (child.stdin) {
    child.stdin.on("error", () => { /* a dead child is reported by close */ });
    child.stdin.end(args.prompt);
  }
  let spawned = false;
  const forward = (signal) => { try { child.kill(signal); } catch { /* already gone */ } };
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => forward(signal));
  child.on("spawn", () => { spawned = true; });
  child.on("error", (error) => {
    if (!spawned) {
      if (!resume) {
        rollbackTaskAdmission(admission);
        try {
          for (const file of [systemPromptFile, settingsFile].filter(Boolean)) fs.rmSync(file, { force: true });
          fs.rmdirSync(path.dirname(systemPromptFile));
        } catch { /* other prompts remain */ }
      }
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
