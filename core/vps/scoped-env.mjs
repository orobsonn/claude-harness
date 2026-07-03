#!/usr/bin/env node
/**
 * @description Scaffold stub for the VPS scoped-env builder (task-2-scoped-env). Not yet
 * implemented — throws so the paired test suite (scoped-env.test.mjs) collects and runs RED.
 *
 * Contract this will eventually satisfy (see scoped-env.test.mjs for the pinned assertions):
 * - NEVER blindly inherit opts.baseEnv into the returned env (excludes ~/.bashrc-sourced
 *   aliases like Cloudflare shortcuts — those are shell conveniences, not session state).
 * - Includes ONLY the target project's own .dev.vars keys (opts.projectDevVars[project]);
 *   every sibling project's .dev.vars entry in that same map must be excluded.
 * - NEVER injects ANTHROPIC_AUTH_TOKEN into the returned (parent) env — the parent `claude -p`
 *   authenticates via its own ~/.claude Claude Code config, and setting this key would 401 it.
 *   ANTHROPIC_AUTH_TOKEN is the Ollama hand-token fallback key, not a parent credential.
 * - MUST preserve OLLAMA_HAND_TOKEN from opts.claudeDevVarsContent so spawn-hand can later
 *   resolve the cheap-hand token from the returned env.
 */

/**
 * @description Builds the scoped env object to spawn a project's `claude -p` session with.
 * NOT YET IMPLEMENTED — throws.
 * @param {string} project - Target project identifier; must match a key in opts.projectDevVars.
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.baseEnv] - Parent/base env to start from (may carry
 *   ~/.bashrc-sourced aliases, HOME, PATH, etc.) — not blindly inherited.
 * @param {Record<string,string>} [opts.projectDevVars] - Map of project name -> raw .dev.vars
 *   file content, one entry per project directory discovered on the VPS (siblings included).
 * @param {string} [opts.claudeDevVarsContent] - Raw content of ~/.claude/.dev.vars, carrying the
 *   global tokens (ANTHROPIC_AUTH_TOKEN, OLLAMA_HAND_TOKEN).
 * @returns {Record<string,string>} The scoped env object to spawn the session with.
 */
export function buildScopedEnv(project, opts = {}) {
  throw new Error("not implemented");
}
