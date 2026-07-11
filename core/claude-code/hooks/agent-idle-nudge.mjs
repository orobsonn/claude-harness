/**
 * @description PostToolUse(Agent) hook that nudges a main-loop agent which idled
 * without delivering its final structured report. Mirrors codex-eye-nudge.mjs
 * literally: pure decide() + processInput() + a guarded CLI entry. NO statefile.
 *
 * Fail-open: exits 0 on ANY error. Never blocks an Agent dispatch.
 * The single injected additionalContext carries BOTH the single-nudge directive
 * (send exactly one SendMessage re-prompt to extract the report) AND the fallback
 * directive (if still no report, record it as unresolved and do NOT loop /
 * do NOT re-dispatch). There is NO second automatic retry loop.
 *
 * Runtime contract (load-bearing): a main-loop Agent dispatch OMITS the `agent_id`
 * key; a nested/subagent dispatch INCLUDES it. This hook keys "main-loop only" off
 * that presence (hasOwnProperty), matching the harness gate convention
 * (entry-gate.mjs / stamp-triage.mjs / plan-write-gate.mjs), NOT truthiness — so a
 * falsy-but-present agent_id ('' / 0 / null) is correctly read as a nested dispatch.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Pure decision layer — no I/O
// ---------------------------------------------------------------------------

/**
 * Coerces the report text out of a payload. The payload is idle ONLY when BOTH
 * tool_response and tool_output are idle. A field is idle when it is null/undefined
 * OR a string that trims to ''. Any non-string non-null value (number, boolean,
 * object, array) counts as a report (NOT idle) — so an empty-string tool_response
 * does not mask a real report in tool_output (and vice versa).
 *
 * Branches on `typeof v === 'string'` (then trim) BEFORE the null check — never on
 * truthiness — so `0`/`false` fall into the report branch literally.
 *
 * @param {unknown} payload - The hook payload
 * @returns {boolean} true when BOTH report fields are idle (absent or blank)
 */
function isIdleReport(payload) {
  // A field is idle when null/undefined OR a string that trims to ''. Any non-string
  // non-null value (number 0, boolean false, object, array) is a report (NOT idle).
  // The payload is idle ONLY when BOTH fields are idle — an empty-string tool_response
  // must not mask a real report present in tool_output (and vice versa).
  const isFieldIdle = (v) =>
    v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  return isFieldIdle(payload.tool_response) && isFieldIdle(payload.tool_output);
}

/**
 * Decides whether to inject an idle-nudge context. Pure. Never throws.
 * Returns {action:'inject', context} on a qualifying idle transition, else {action:'none'}.
 *
 * @param {unknown} payload - The hook payload
 * @param {object} _env - Env object (unused; kept for signature parity with siblings)
 * @param {object} [_deps] - Injectable dependencies (unused; kept for parity)
 * @returns {{ action: 'inject', context: string } | { action: 'none' }}
 */
export function decide(payload, _env, _deps) {
  // (a) payload is null/not an object, or payload.tool_input is missing/non-object
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { action: 'none' };
  }
  const ti = payload.tool_input;
  if (typeof ti !== 'object' || ti === null || Array.isArray(ti)) {
    return { action: 'none' };
  }

  // (b) payload.agent_id present — nested dispatch (main-loop only). Presence, not
  // truthiness: a falsy-but-present agent_id ('' or 0) is still a nested dispatch.
  if (Object.prototype.hasOwnProperty.call(payload, 'agent_id')) {
    return { action: 'none' };
  }

  // (c) payload.tool_name !== 'Agent'
  if (payload.tool_name !== 'Agent') {
    return { action: 'none' };
  }

  // (d) report text non-empty — a delivered report is not nudged
  if (!isIdleReport(payload)) {
    return { action: 'none' };
  }

  // Qualifying idle transition — inject the combined single-nudge + no-loop directive.
  const context =
    'Agent idle nudge: this Agent dispatch returned without a final structured report. ' +
    'Send EXACTLY ONE SendMessage re-prompt to the same agent to extract its report — ' +
    'do not send more than one, and do not re-dispatch the Agent tool. ' +
    'If the single re-prompt still yields no report, record the task as UNRESOLVED ' +
    'and do NOT loop and do NOT re-dispatch.';

  return { action: 'inject', context };
}

// ---------------------------------------------------------------------------
// processInput — production entry point (stdin → stdout)
// ---------------------------------------------------------------------------

/**
 * Parses raw stdin, calls decide, and returns the hook output shape.
 * Never throws — any error yields { exitCode: 0, output: null }.
 *
 * @param {string} rawStr - Raw stdin string (JSON payload)
 * @param {object} [_deps] - Injectable dependencies (kept for parity; unused)
 * @returns {{ exitCode: number, output: string|null }}
 */
export function processInput(rawStr, _deps) {
  try {
    const payload = JSON.parse(rawStr);

    const d = decide(payload, {}, {});

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