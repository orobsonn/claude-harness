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
 * - the lane runtime manifest is re-verified before the child starts.
 */
import fs from "node:fs";
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
export function laneEnvironment(processEnvironment) {
  const env = {};
  for (const [key, value] of Object.entries(processEnvironment)) {
    if (typeof value !== "string") continue;
    if (ALLOWED.has(key) || key.startsWith("LC_")) env[key] = value;
  }
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = "1";
  return env;
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
    childEnvironment: (processEnvironment) => laneEnvironment(processEnvironment),
    verifyRuntime: verifyTaskRuntime,
    killGraceMs: 10_000,
    trackDescendants: true,
  });
}
