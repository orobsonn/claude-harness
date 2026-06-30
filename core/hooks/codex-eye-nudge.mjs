/**
 * @description PostToolUse(Agent) hook that injects a cross-family eye nudge
 * when the main loop dispatches an adversary, security, or plan-reviewer Agent
 * and the codex-adversary module is present with HARNESS_CODEX_ADVERSARY on.
 *
 * Fail-open: exits 0 on ANY error. Never blocks an Agent dispatch.
 * The second family is always optional — absent module or switch off = Claude-only.
 */

import fs from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareRole } from './lib/gate-lib.mjs';

// ---------------------------------------------------------------------------
// Eye roles that trigger the cross-family nudge
// ---------------------------------------------------------------------------

const EYE_ROLES = new Set(['adversary', 'security', 'plan-reviewer']);

// ---------------------------------------------------------------------------
// Falsy env values (case-insensitive) — the switch is OFF when the var is
// unset OR set to one of these sentinel values.
// ---------------------------------------------------------------------------

const FALSY_ENV_VALUES = new Set(['', '0', 'false', 'off', 'no']);

/**
 * Returns true when the env var is present AND not one of the falsy sentinels.
 * @param {string|undefined} raw - The raw env-var value
 * @returns {boolean}
 */
function isTruthyEnv(raw) {
  if (raw === undefined) return false;
  return !FALSY_ENV_VALUES.has(raw.toLowerCase());
}

// ---------------------------------------------------------------------------
// Default module-exists probe — production seam
// ---------------------------------------------------------------------------

/**
 * Checks whether the cross-family module file exists under the given cwd.
 * Guards: only probes when cwd is a non-empty absolute string.
 * @param {string} cwd - Absolute project root path
 * @returns {boolean}
 */
function defaultModuleExists(cwd) {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return false;
  return fs.existsSync(join(cwd, '.claude/modules/codex-adversary/references/cross-family.mjs'));
}

// ---------------------------------------------------------------------------
// Pure decision layer — no I/O
// ---------------------------------------------------------------------------

/**
 * Decides whether to inject a cross-family eye nudge.
 * Pure. Never throws. Returns {action:'inject', role, context} or {action:'none'}.
 *
 * @param {unknown} payload - The hook payload
 * @param {object} env - Env object (production: process.env)
 * @param {object} [deps] - Injectable dependencies
 * @param {function} [deps.moduleExists] - (cwd: string) => boolean, defaults to () => false
 * @returns {{ action: 'inject', role: string, context: string }
 *         | { action: 'none' }}
 */
export function decide(payload, env, deps) {
  // (a) payload is null/not an object, or payload.tool_input is missing
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { action: 'none' };
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'tool_input')) {
    return { action: 'none' };
  }

  // (b) payload.agent_id is present (truthy) — main-loop only
  if (payload.agent_id) {
    return { action: 'none' };
  }

  // (c) payload.tool_name !== 'Agent'
  if (payload.tool_name !== 'Agent') {
    return { action: 'none' };
  }

  // (d) role = bareRole(payload.tool_input.subagent_type); role NOT in eye set
  const role = bareRole(payload.tool_input.subagent_type);
  if (!EYE_ROLES.has(role)) {
    return { action: 'none' };
  }

  // (e) env.HARNESS_CODEX_ADVERSARY is falsy
  if (!isTruthyEnv(env.HARNESS_CODEX_ADVERSARY)) {
    return { action: 'none' };
  }

  // (f) cwd guard: typeof cwd !== 'string' || !isAbsolute(cwd) => none
  const cwd = payload.cwd;
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    return { action: 'none' };
  }

  // (g) moduleExists probe — default to () => false when deps is undefined
  const exists = (deps && deps.moduleExists) ? deps.moduleExists : (() => false);
  if (!exists(cwd)) {
    return { action: 'none' };
  }

  // Inject — build context with cross-family.mjs, role name, and AFTER phrase
  const context = `Cross-family eye (${role}): after this eye returns, capture its findings to the --claude file, then run: node .claude/modules/codex-adversary/references/cross-family.mjs --role ${role} --task <task.json> --claude <claude-input.json>, then merge. Deterministic; do not skip.`;

  return { action: 'inject', role, context };
}

// ---------------------------------------------------------------------------
// processInput — production entry point (stdin → stdout)
// ---------------------------------------------------------------------------

/**
 * Parses raw stdin, calls decide with the real FS probe, and returns the
 * hook output shape. Never throws — any error yields { exitCode: 0, output: null }.
 *
 * @param {string} rawStr - Raw stdin string (JSON payload)
 * @param {object} [deps] - Injectable dependencies
 * @param {function} [deps.moduleExists] - Override for the FS probe
 * @param {object} [deps.env] - Override for env (defaults to process.env)
 * @returns {{ exitCode: number, output: string|null }}
 */
export function processInput(rawStr, deps) {
  try {
    const payload = JSON.parse(rawStr);

    const moduleExists = (deps && deps.moduleExists) ? deps.moduleExists : defaultModuleExists;
    const env = (deps && deps.env) ? deps.env : process.env;

    const d = decide(payload, env, { moduleExists });

    if (d.action === 'inject') {
      return {
        exitCode: 0,
        output: JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: d.context,
          },
        }),
      };
    }

    return { exitCode: 0, output: null };
  } catch {
    return { exitCode: 0, output: null };
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — guarded so imports from tests do not trigger side effects
// ---------------------------------------------------------------------------

function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectCli()) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }

  const result = processInput(raw);
  if (result.output !== null) {
    process.stdout.write(result.output);
  }
  process.exit(0);
}
