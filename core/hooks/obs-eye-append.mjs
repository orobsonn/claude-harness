/**
 * @description PostToolUse(Agent) hook that appends one observability event per
 * main-loop eye return (compliance / adversary / security / plan-reviewer) to the
 * per-run outbox. Modeled on codex-eye-nudge.mjs.
 *
 * Guarded: main-loop only (skips when payload.agent_id is present), tool_name==='Agent',
 * bareRole(tool_input.subagent_type) in the eye set, and HARNESS_OBSERVABILITY_RUN_PATH
 * points at an existing obs meta file.
 *
 * Append is via obs-outbox appendEvent (appendFileSync JSONL) — NO fetch is ever issued.
 * Fail-open: exits 0 on ANY error. Never blocks an Agent dispatch and never throws.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bareRole } from './lib/gate-lib.mjs';
import { appendEvent as defaultAppendEvent } from '../vps/obs-outbox.mjs';

// ---------------------------------------------------------------------------
// Eye roles that trigger an observability append
// ---------------------------------------------------------------------------

const EYE_ROLES = new Set(['compliance', 'adversary', 'security', 'plan-reviewer']);

// ---------------------------------------------------------------------------
// Pure decision layer — no I/O
// ---------------------------------------------------------------------------

/**
 * Decides whether to append an eye event to the outbox.
 * Pure. Never throws. Returns {action:'append', role, metaPath} or {action:'none'}.
 *
 * @param {unknown} payload - The hook payload
 * @param {object} env - Env object (production: process.env)
 * @param {object} [deps] - Injectable dependencies
 * @param {function} [deps.existsSync] - (path: string) => boolean, defaults to () => false
 * @returns {{ action: 'append', role: string, metaPath: string }
 *         | { action: 'none' }}
 */
export function decide(payload, env, deps) {
  // (a) payload is null/not an object, or payload.tool_input is missing
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { action: 'none' };
  }
  const ti = payload.tool_input;
  if (typeof ti !== 'object' || ti === null || Array.isArray(ti)) {
    return { action: 'none' };
  }

  // (b) payload.agent_id present (truthy) — main-loop only
  if (payload.agent_id) {
    return { action: 'none' };
  }

  // (c) payload.tool_name !== 'Agent'
  if (payload.tool_name !== 'Agent') {
    return { action: 'none' };
  }

  // (d) role = bareRole(ti.subagent_type); role NOT in eye set
  const role = bareRole(ti.subagent_type);
  if (typeof role !== 'string' || !EYE_ROLES.has(role)) {
    return { action: 'none' };
  }

  // (e) env.HARNESS_OBSERVABILITY_RUN_PATH falsy/absent
  const metaPath = env && env.HARNESS_OBSERVABILITY_RUN_PATH;
  if (typeof metaPath !== 'string' || metaPath.length === 0) {
    return { action: 'none' };
  }

  // (f) existsSync probe — default to () => false when deps is undefined
  const exists = (deps && deps.existsSync) ? deps.existsSync : (() => false);
  if (!exists(metaPath)) {
    return { action: 'none' };
  }

  return { action: 'append', role, metaPath };
}

// ---------------------------------------------------------------------------
// processInput — production entry point (stdin → stdout)
// ---------------------------------------------------------------------------

/**
 * Parses raw stdin, calls decide with the real FS probe, and appends an eye event
 * to the outbox on a positive decision. Never fetches. Never throws — any error
 * yields { exitCode: 0 } (fail-open).
 *
 * @param {string} rawStr - Raw stdin string (JSON payload)
 * @param {object} [deps] - Injectable dependencies
 * @param {function} [deps.existsSync] - Override for the FS probe (default fs.existsSync)
 * @param {function} [deps.appendEvent] - Override for the outbox append (default obs-outbox appendEvent)
 * @param {object} [deps.env] - Override for env (defaults to process.env)
 * @returns {{ exitCode: number }}
 */
export function processInput(rawStr, deps) {
  try {
    const payload = JSON.parse(rawStr);

    const existsSync = (deps && deps.existsSync) ? deps.existsSync : fs.existsSync;
    const env = (deps && deps.env) ? deps.env : process.env;
    const appendEvent = (deps && deps.appendEvent) ? deps.appendEvent : defaultAppendEvent;

    const d = decide(payload, env, { existsSync });

    if (d.action === 'append') {
      appendEvent(d.metaPath, { type: 'eye', role: d.role });
    }

    return { exitCode: 0 };
  } catch {
    return { exitCode: 0 };
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

  processInput(raw);
  process.exit(0);
}