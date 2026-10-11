/**
 * @description PreToolUse / PostToolUse / PostToolUseFailure / SubagentStop (*) hook — the lane's
 * host-owned ledger. Inert outside a task lane (`CLAUDE_HARNESS_TASK_RUN` absent).
 *
 * For every Bash and Agent call (main loop and subagents) it appends one JSON line before and one
 * after the call to `.claude/plans/.state/<laneSession>/task-ledger.jsonl`, recording what the
 * model cannot assert: the Git HEAD and the non-volatile dirty paths at both boundaries, the tool
 * status, the Bash exit code (from Claude Code's own `Exit code N` failure text) and the Agent's
 * native id/async flag. The host inspection pairs these with the native stream-json by
 * `tool_use_id`; the freeze commit is the call whose HEAD moved, never a SHA parsed from stdout.
 *
 * Fail-open by design (exit 0, no output): a missing ledger line makes the host inspection block
 * the task, which is the safe direction.
 */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseTaskRunEnv } from "./task-gate.mjs";
import { TASK_RUN_ENV, isVolatileHarnessPath, laneLedgerFile, sessionStateDir } from "./lib/task-paths.mjs";

const LEDGER_TOOLS = new Set(["Bash", "Agent", "Task"]);
const MAX_DIRTY = 200;

function gitFacts(root) {
  const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let head = null;
  let dirty = null;
  try { head = run("rev-parse", "HEAD").trim(); } catch { head = null; }
  try {
    dirty = [...new Set([
      ...run("diff", "--name-only", "-z", "HEAD", "--").split("\0"),
      ...run("ls-files", "--others", "--exclude-standard", "-z").split("\0"),
    ].filter((name) => name && !isVolatileHarnessPath(name)))].sort().slice(0, MAX_DIRTY);
  } catch {
    dirty = null;
  }
  let merging = false;
  try { run("rev-parse", "--verify", "-q", "MERGE_HEAD"); merging = true; } catch { merging = false; }
  return { head, dirty, merging };
}

/** `Exit code N` prefix that Claude Code writes for a failed Bash call; null when absent. */
export function parseExitCode(error) {
  const match = String(error ?? "").match(/^Exit code (\d+)\b/);
  return match ? Number(match[1]) : null;
}

/** Build the ledger record for one hook payload, or null when the event is not ledgered. */
export function ledgerRecord(payload, facts, now = new Date().toISOString()) {
  const event = payload.hook_event_name;
  const base = {
    v: 1,
    at: now,
    session_id: payload.session_id,
    agent_id: typeof payload.agent_id === "string" ? payload.agent_id : null,
    agent_type: typeof payload.agent_type === "string" ? payload.agent_type : null,
  };
  if (event === "SubagentStop") return { ...base, event: "subagent_stop", stop_hook_active: payload.stop_hook_active === true };
  if (!LEDGER_TOOLS.has(payload.tool_name) || typeof payload.tool_use_id !== "string") return null;
  const input = payload.tool_input ?? {};
  const call = payload.tool_name === "Bash"
    ? { tool: "Bash", command: typeof input.command === "string" ? input.command : null }
    : {
        tool: "Agent",
        subagent_type: typeof input.subagent_type === "string" ? input.subagent_type : null,
        model: typeof input.model === "string" ? input.model : null,
        prompt_sha256: typeof input.prompt === "string" ? createHash("sha256").update(input.prompt).digest("hex") : null,
      };
  const common = { ...base, ...call, tool_use_id: payload.tool_use_id, head: facts.head, dirty: facts.dirty, merging: facts.merging };
  if (event === "PreToolUse") return { ...common, event: "pre" };
  if (event === "PostToolUse") {
    const response = payload.tool_response;
    return {
      ...common,
      event: "post",
      status: "ok",
      exit_code: call.tool === "Bash" ? 0 : null,
      ...(call.tool === "Agent" ? {
        agent_status: typeof response?.status === "string" ? response.status : null,
        native_agent_id: typeof response?.agentId === "string" ? response.agentId : null,
        is_async: response?.isAsync === true,
      } : {}),
    };
  }
  if (event === "PostToolUseFailure") {
    return { ...common, event: "post", status: "error", exit_code: call.tool === "Bash" ? parseExitCode(payload.error) : null, interrupted: payload.is_interrupt === true };
  }
  return null;
}

/** Append the payload's ledger line inside the admitted lane; returns the record or null. */
export function handle(payload, { env = process.env, cwd = process.cwd(), now } = {}) {
  if (!Object.hasOwn(env, TASK_RUN_ENV)) return null;
  const binding = parseTaskRunEnv(env[TASK_RUN_ENV]);
  if (!binding || !payload || typeof payload !== "object" || payload.session_id !== binding.sessionId) return null;
  let root;
  try {
    root = fs.realpathSync(binding.cwd);
    if (fs.realpathSync(cwd) !== root || !fs.existsSync(sessionStateDir(root, binding.sessionId))) return null;
  } catch {
    return null;
  }
  const record = ledgerRecord(payload, payload.hook_event_name === "SubagentStop" ? {} : gitFacts(root), now);
  if (!record) return null;
  fs.appendFileSync(laneLedgerFile(root, binding.sessionId), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return record;
}

function isDirectCli() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return process.argv[1] === fileURLToPath(import.meta.url);
  }
}

if (isDirectCli()) {
  try {
    handle(JSON.parse(fs.readFileSync(0, "utf8")));
  } catch {
    /* fail-open: the inspection blocks a task whose ledger is incomplete */
  }
  process.exit(0);
}
