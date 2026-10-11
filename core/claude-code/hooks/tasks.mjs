#!/usr/bin/env node
/**
 * @description Host CLI for parallel task lanes, run by the global parent through Bash:
 *
 *   node .claude/hooks/tasks.mjs <dispatch|status|wait|integrate|resume|abandon-resume> [--json '<params>' | --json-file <path>]
 *
 * Identity is the host's, never a parameter: the parent session is `CLAUDE_CODE_SESSION_ID` (set by
 * Claude Code in every Bash call; task-gate.mjs only lets this command run alone, without an env
 * prefix) and the project root is the cwd. stdout is one JSON object; exit 0 when ok, 1 otherwise.
 * `wait` blocks on the host without calling the model for at most 540 s (below the 600 s Bash
 * ceiling): run it with an explicit Bash timeout of 600000. Interrupting `wait` never stops a task.
 * Host env: CLAUDE_HARNESS_TASK_WAIT_POLL_MS (50–5000, default 5000) tunes the wait poll.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeTaskAction, waitForTasks, TASK_ACTION_FIELDS } from "./lib/task-coordinator.mjs";
import { TASK_RUN_ENV } from "./lib/task-paths.mjs";

const MAX_PARAMS_BYTES = 64 * 1024;

export function parseCliArgs(argv, cwd = process.cwd()) {
  const [action, flag, value, ...rest] = argv;
  if (!Object.hasOwn(TASK_ACTION_FIELDS, action ?? "")) throw new Error(`usage: tasks.mjs <${Object.keys(TASK_ACTION_FIELDS).join("|")}> [--json '<params>' | --json-file <path>]`);
  if (rest.length) throw new Error("unexpected extra arguments");
  let raw = "{}";
  if (flag === "--json") raw = value ?? "";
  else if (flag === "--json-file") {
    const file = path.resolve(cwd, value ?? "");
    if (fs.statSync(file).size > MAX_PARAMS_BYTES) throw new Error("params file is too large");
    raw = fs.readFileSync(file, "utf8");
  } else if (flag !== undefined) throw new Error("expected --json or --json-file");
  if (Buffer.byteLength(raw, "utf8") > MAX_PARAMS_BYTES) throw new Error("params are too large");
  const params = JSON.parse(raw);
  if (!params || typeof params !== "object" || Array.isArray(params)) throw new Error("params must be a JSON object");
  if (Object.hasOwn(params, "action") && params.action !== action) throw new Error("params.action differs from the command action");
  return { ...params, action };
}

export async function runTasksCli(argv, { env = process.env, cwd = process.cwd(), signal, injected = {} } = {}) {
  let params;
  try {
    params = parseCliArgs(argv, cwd);
  } catch (error) {
    return { ok: false, reason: `[harness-tasks] ${error.message}` };
  }
  const context = { projectRoot: cwd, sessionId: env.CLAUDE_CODE_SESSION_ID, isLane: Object.hasOwn(env, TASK_RUN_ENV) };
  if (params.action === "wait") {
    const poll = Number(env.CLAUDE_HARNESS_TASK_WAIT_POLL_MS);
    const pollMs = Number.isInteger(poll) ? Math.min(5000, Math.max(50, poll)) : 5000;
    return waitForTasks(params, context, { pollMs, ...injected, signal });
  }
  return executeTaskAction(params, context, injected);
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
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => controller.abort());
  runTasksCli(process.argv.slice(2), { signal: controller.signal })
    .then((result) => {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result?.ok ? 0 : 1;
    })
    .catch((error) => {
      process.stdout.write(`${JSON.stringify({ ok: false, reason: `[harness-tasks] ${error instanceof Error ? error.message : String(error)}` })}\n`);
      process.exitCode = 1;
    });
}
