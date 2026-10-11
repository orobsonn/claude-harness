#!/usr/bin/env node
/**
 * @description Claude Code task supervisor bin. One detached process group per lane launch, run by
 * the shared supervisor (`core/shared/lib/task-worker.mjs`) with the Claude lane policy:
 * - environment by ALLOWLIST (system basics, proxy/CA, Anthropic auth, CLAUDE_CONFIG_DIR) — every
 *   other `CLAUDE*`, `ORCA_*`, `HARNESS_*` and dispatch variable of the parent session is dropped,
 *   including an inherited `CLAUDE_HARNESS_TASK_RUN` (the launcher sets the lane's own);
 * - `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` so lane Agents run in the foreground (spike §2);
 * - descendant tracking with a 10 s SIGTERM grace: Claude Code's Bash tool runs in its own session
 *   and only survives a SIGKILL of the CLI (spike §7);
 * - the lane runtime manifest is re-verified before the child starts;
 * - in an Orca terminal (`job.terminal_mode`) the Orca pane variables (`ORCA_*`) are kept so Orca's
 *   agent-status hooks report the lane, the parent's non-secret CLAUDE_CONFIG_DIR crosses through
 *   `job.profile_environment`, and each native event is rendered as one sanitized progress line.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTaskWorker } from "../../../shared/lib/task-worker.mjs";
import { verifyTaskRuntime } from "./task-runtime.mjs";

const ALLOWED = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LANGUAGE", "TERM", "TMPDIR", "TZ",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR",
]);

/** The lane environment: allowlisted keys only, plus the forced foreground switch. */
export function laneEnvironment(processEnvironment, { orca = false } = {}) {
  const env = {};
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (typeof value !== "string") continue;
    if (ALLOWED.has(key) || key.startsWith("LC_") || (orca && key.startsWith("ORCA_"))) env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  return env;
}

/** Child env for one job: Orca terminals keep their pane identity and the parent's config dir. */
export function laneJobEnvironment(processEnvironment, job) {
  const terminal = job?.terminal_mode === true;
  const env = laneEnvironment(processEnvironment, { orca: terminal });
  const configDir = job?.profile_environment?.CLAUDE_CONFIG_DIR;
  if (terminal && typeof configDir === "string" && path.isAbsolute(configDir) && !configDir.includes("\0")) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// Model text reaches a real terminal: strip every control character (ESC sequences could rewrite
// the screen, set the title or inject OSC links).
const clean = (value, max) => {
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** One readable progress line for an Orca terminal per native stream-json event ("" to skip). */
export function renderLaneEvent(line) {
  let event;
  try { event = JSON.parse(line); } catch { return ""; }
  if (!event || typeof event !== "object") return "";
  const nested = typeof event.parent_tool_use_id === "string";
  if (event.type === "system" && event.subtype === "init") return `▶ lane ${clean(event.session_id, 40)} · ${clean(event.model, 40)} · ${clean(event.cwd, 200)}\n`;
  if (event.type === "result") {
    const cost = typeof event.total_cost_usd === "number" ? ` · US$ ${event.total_cost_usd.toFixed(2)}` : "";
    return `■ ${clean(event.subtype, 40)}${event.is_error ? " (erro)" : ""}${cost}\n`;
  }
  const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
  const out = [];
  for (const block of blocks) {
    if (event.type === "assistant" && block?.type === "text" && !nested) out.push(`  ${clean(block.text, 300)}`);
    if (event.type === "assistant" && block?.type === "tool_use") {
      const input = block.input ?? {};
      const what = block.name === "Bash" ? clean(input.command, 160)
        : block.name === "Agent" || block.name === "Task" ? `${clean(input.subagent_type, 40)} · ${clean(input.model, 20)}`
        : clean(input.file_path ?? input.pattern ?? "", 160);
      out.push(`${nested ? "    ↳" : "•"} ${clean(block.name, 30)} ${what}`);
    }
    if (event.type === "user" && block?.type === "tool_result" && block.is_error === true) {
      const text = typeof block.content === "string" ? block.content : (Array.isArray(block.content) ? block.content.map((item) => item?.text ?? "").join(" ") : "");
      out.push(`${nested ? "    " : "  "}✗ ${clean(text, 200)}`);
    }
  }
  return out.length ? `${out.join("\n")}\n` : "";
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
  runTaskWorker({
    childEnvironment: (processEnvironment, job) => laneJobEnvironment(processEnvironment, job),
    renderEventLine: renderLaneEvent,
    verifyRuntime: verifyTaskRuntime,
    killGraceMs: 10_000,
    trackDescendants: true,
  });
}
