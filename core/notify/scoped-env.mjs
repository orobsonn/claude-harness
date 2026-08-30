#!/usr/bin/env node
/**
 * @description VPS scoped-env builder (task-2-scoped-env). Builds the env object used to spawn
 * a project's `claude -p` parent session on the VPS as an explicit allowlist composition —
 * never a mutation/copy of the base env.
 *
 * Contract (see scoped-env.test.mjs for the pinned assertions):
 * - NEVER blindly inherit opts.baseEnv into the returned env (excludes ~/.bashrc-sourced
 *   aliases like Cloudflare shortcuts — those are shell conveniences, not session state). Only
 *   PATH/HOME are carried through from baseEnv, since a spawned session legitimately needs them.
 * - Includes ONLY the target project's own .dev.vars keys (opts.projectDevVars[project]);
 *   every sibling project's .dev.vars entry in that same map is excluded.
 * - NEVER injects ANTHROPIC_AUTH_TOKEN into the returned (parent) env — the parent `claude -p`
 *   authenticates via its own ~/.claude Claude Code config, and setting this key would 401 it.
 *   ANTHROPIC_AUTH_TOKEN is the Ollama hand-token fallback key, not a parent credential. This
 *   holds REGARDLESS OF SOURCE — including the project's own .dev.vars, not just
 *   opts.claudeDevVarsContent — via PROJECT_DEV_VARS_DENYLIST.
 * - The target project's own .dev.vars is untrusted input: PROJECT_DEV_VARS_DENYLIST strips
 *   process/loader hijack vectors (NODE_OPTIONS, LD_PRELOAD, LD_LIBRARY_PATH, LD_AUDIT,
 *   LD_PROFILE, DYLD_INSERT_LIBRARIES, IFS, BASH_ENV, ENV) plus PATH/HOME (must stay the
 *   base-resolved values, never project-overridden) before merge — a denylist of dangerous
 *   keys, not an allowlist, since the project's legitimate secrets are arbitrary names.
 * - MUST preserve OLLAMA_HAND_TOKEN from opts.claudeDevVarsContent so spawn-hand can later
 *   resolve the cheap-hand token from the returned env.
 */

const BASE_ENV_ALLOWLIST = ["PATH", "HOME"];

/** Keys from ~/.claude/.dev.vars that are safe to carry into the parent session env. */
const CLAUDE_DEV_VARS_ALLOWLIST = ["OLLAMA_HAND_TOKEN"];

/**
 * Keys that must NEVER pass through from a project's own `.dev.vars` into the spawned
 * session env, regardless of source: the parent-credential token (would 401 `claude -p`,
 * see module contract) plus process/loader hijack vectors a project's `.dev.vars` has no
 * legitimate reason to set (code-exec injection, or overriding the resolved PATH/HOME).
 */
const PROJECT_DEV_VARS_DENYLIST = [
  "ANTHROPIC_AUTH_TOKEN",
  "NODE_OPTIONS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "LD_PROFILE",
  "DYLD_INSERT_LIBRARIES",
  "IFS",
  "BASH_ENV",
  "ENV",
  "PATH",
  "HOME",
];

/**
 * @description Removes denylisted keys (in place) from a parsed vars map before it is merged
 * into the scoped env.
 * @param {Record<string,string>} vars - Parsed key/value map.
 * @returns {Record<string,string>} The same map, mutated, for chaining convenience.
 */
function stripDenylistedKeys(vars) {
  for (const key of PROJECT_DEV_VARS_DENYLIST) {
    delete vars[key];
  }
  return vars;
}

/**
 * @description Applies dotenv-style value handling to a trimmed raw value segment: a value
 * wrapped in matching single/double quotes is taken literally (a `#` inside the quotes is part
 * of the value, not a comment) — quote-matching is checked BEFORE comment-stripping so a
 * trailing ` # comment` after the closing quote doesn't defeat the quote match. An unquoted
 * value has a trailing whitespace-preceded `#...` comment stripped before trimming. A value
 * that opens with a quote but never closes it has the orphan leading quote stripped rather than
 * left embedded in the value.
 * @param {string} rawValue - Trimmed raw value segment after the `=`.
 * @returns {string} The cleaned value.
 */
function stripValueQuotesAndComment(rawValue) {
  if (rawValue.length >= 1) {
    const first = rawValue[0];
    if (first === '"' || first === "'") {
      const escapedQuote = first === '"' ? '\\"' : "\\'";
      const quotedMatch = rawValue.match(
        new RegExp(`^${escapedQuote}([\\s\\S]*)${escapedQuote}\\s*(?:#.*)?$`)
      );
      if (quotedMatch) return quotedMatch[1];

      // Unbalanced leading quote (e.g. `KEY="oll` with no closing quote): strip the orphan
      // opening quote rather than leaving it embedded in the value or crashing.
      return rawValue.slice(1);
    }
  }

  const commentMatch = rawValue.match(/\s+#.*$/);
  if (commentMatch) return rawValue.slice(0, commentMatch.index).trim();

  return rawValue.trim();
}

/**
 * @description Parses simple `KEY=value` line-based env-file text (as used by `.dev.vars`),
 * ignoring blank lines and `#` comments. Tolerates a leading `export ` prefix, surrounding
 * quotes, and unquoted trailing `# comment` suffixes on the value.
 * @param {string} content - Raw file content.
 * @returns {Record<string,string>} Parsed key/value map.
 */
export function parseDevVars(content) {
  const result = {};
  if (!content) return result;

  for (const rawLine of content.split("\n")) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("export ")) {
      line = line.slice("export ".length).trim();
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) continue;

    const key = line.slice(0, eqIndex).trim();
    const rawValue = line.slice(eqIndex + 1).trim();
    if (!key) continue;

    result[key] = stripValueQuotesAndComment(rawValue);
  }

  return result;
}

/**
 * @description Builds the scoped env object to spawn a project's `claude -p` session with, as
 * an explicit allowlist composition (base PATH/HOME + the target project's own .dev.vars +
 * the safe subset of ~/.claude/.dev.vars) — never a copy of the base env.
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
  const { baseEnv = {}, projectDevVars = {}, claudeDevVarsContent = "" } = opts;

  const env = {};

  for (const key of BASE_ENV_ALLOWLIST) {
    if (key in baseEnv) env[key] = baseEnv[key];
  }

  const projectVars = stripDenylistedKeys(parseDevVars(projectDevVars[project] ?? ""));
  Object.assign(env, projectVars);

  const claudeVars = parseDevVars(claudeDevVarsContent);
  for (const key of CLAUDE_DEV_VARS_ALLOWLIST) {
    if (key in claudeVars) env[key] = claudeVars[key];
  }

  return env;
}
