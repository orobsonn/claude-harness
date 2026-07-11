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
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bareRole } from './lib/gate-lib.mjs';
import {
  appendEvent as defaultAppendEvent,
  readMeta as defaultReadMeta,
  readEvents as defaultReadEvents,
} from '../vps/obs-outbox.mjs';

// ---------------------------------------------------------------------------
// Eye roles that trigger an observability append
// ---------------------------------------------------------------------------

const EYE_ROLES = new Set(['compliance', 'adversary', 'security', 'plan-reviewer']);

/**
 * @description Extracts the plan-reviewer verdict from the Agent's returned text. The plan-reviewer's
 * contract is to return exactly one of APPROVE|REVISE. Prefers the anchored contract form
 * ("verdict: APPROVE") so casual prose ("no need to revise — APPROVE") does not false-positive;
 * falls back to a bare UPPERCASE token only (a lowercase "revise" in prose is not a verdict). REVISE
 * wins if both appear (conservative — surface "needs work"). Tolerant of string or object
 * `tool_response` shapes. Returns null when neither is present (the event is still emitted, just
 * without a verdict). Pure, never throws.
 * @param {object} payload
 * @returns {'APPROVE'|'REVISE'|null}
 */
function parseVerdict(payload) {
  try {
    const resp = payload.tool_response ?? payload.tool_output ?? '';
    const text = typeof resp === 'string' ? resp : JSON.stringify(resp);
    const anchored = text.match(/\bverdict\b[:\s]*["']?(APPROVE|REVISE)\b/i);
    if (anchored) return anchored[1].toUpperCase();
    // Fallback: a bare token, UPPERCASE-only (the reviewer writes the verdict in caps).
    if (/\bREVISE\b/.test(text)) return 'REVISE';
    if (/\bAPPROVE\b/.test(text)) return 'APPROVE';
    return null;
  } catch {
    return null;
  }
}

/**
 * @description Fail-open probe: has the run already produced an execution plan? Reads the meta's
 * worktreePath and looks for any `.claude/plans/<feature>/execution-plan.json`. Used to tell a
 * SPEC-phase adversary (before any plan) from a per-task / final-review adversary. Any error → false
 * (treat as spec phase is NOT assumed — a throw means we cannot confirm the plan, so we return false
 * only when the dir is genuinely empty/unreadable; callers combine this with a dedupe guard).
 * @param {string} metaPath
 * @param {{ readMeta: Function, readdirSync: Function, statSync: Function }} io
 * @returns {boolean}
 */
function planExistsFor(metaPath, io) {
  try {
    const meta = io.readMeta(metaPath);
    const wt = meta && meta.worktreePath;
    if (typeof wt !== 'string' || !wt) return false;
    const plansDir = join(wt, '.claude', 'plans');
    for (const entry of io.readdirSync(plansDir)) {
      try {
        if (io.statSync(join(plansDir, entry, 'execution-plan.json')).isFile()) return true;
      } catch {
        // entry has no plan file — keep scanning
      }
    }
    return false;
  } catch {
    return false;
  }
}

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

  // Compute the CURATED event for this eye return (see B1/B3):
  //  - plan-reviewer  → {type:'plan-reviewed', verdict?} — covers "plan review" + "plan approved".
  //  - adversary in the SPEC phase (no execution-plan.json yet AND no spec-adversary already recorded)
  //    → {type:'spec-adversary'} — the operator's wish #3. A later adversary (per-task / final review)
  //    falls through to a raw eye.
  //  - anything else  → {type:'eye', role} — audit-only; the drain allowlist suppresses it from the feed.
  const hasEvent = deps && typeof deps.hasEvent === 'function' ? deps.hasEvent : () => false;
  const countEvents = deps && typeof deps.countEvents === 'function' ? deps.countEvents : () => 0;

  if (role === 'plan-reviewer') {
    const verdict = parseVerdict(payload);
    // Number the review round (1-based) so the feed shows "revisão 1", "revisão 2"… A REVISE→re-plan
    // cycle dispatches the plan-reviewer again; each return counts the plan-reviewed events already in
    // the outbox and stamps round = count + 1. This is the deterministic producer of the round — the
    // stamp-triage mark.mjs fallback (no round) is deduped away by (type, verdict) when this fires.
    const round = countEvents(metaPath, 'plan-reviewed') + 1;
    const event = verdict
      ? { type: 'plan-reviewed', verdict, round }
      : { type: 'plan-reviewed', round };
    return { action: 'append', role, metaPath, event };
  }
  if (role === 'adversary') {
    // Phase probe (readMeta + readdir sweep) only where it matters — never on compliance/security/
    // plan-reviewer returns in this hot PostToolUse hook.
    const planExists = deps && typeof deps.planExists === 'function' ? deps.planExists(metaPath) : false;
    if (!planExists && !hasEvent(metaPath, 'spec-adversary')) {
      return { action: 'append', role, metaPath, event: { type: 'spec-adversary' } };
    }
  }
  return { action: 'append', role, metaPath, event: { type: 'eye', role } };
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
    const readMeta = (deps && deps.readMeta) ? deps.readMeta : defaultReadMeta;
    const readEvents = (deps && deps.readEvents) ? deps.readEvents : defaultReadEvents;

    const planExists = (mp) =>
      planExistsFor(mp, { readMeta, readdirSync: fs.readdirSync, statSync: fs.statSync });
    const hasEvent = (mp, type) => {
      try {
        return (readEvents(mp) || []).some((e) => e && e.type === type);
      } catch {
        return false;
      }
    };
    const countEvents = (mp, type) => {
      try {
        return (readEvents(mp) || []).filter((e) => e && e.type === type).length;
      } catch {
        return 0;
      }
    };

    const d = decide(payload, env, { existsSync, planExists, hasEvent, countEvents });

    if (d.action === 'append') {
      appendEvent(d.metaPath, d.event);
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