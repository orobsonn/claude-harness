/**
 * @description PostToolUse(Bash) hook that stamps triage.json and gate-state.json
 * from trusted model-invoked marker commands.
 *
 * Recognises two command patterns via tool_input.command:
 *   - classify.mjs  → parse {mode, feature_id} from tool_response (stdout JSON),
 *                      re-validate via gate-lib, write atomic triage.json.
 *   - mark.mjs brainstorm-done → merge { brainstormed: true } into gate-state.json
 *                                 (main-loop only: skip when payload.agent_id present).
 *
 * Fail-open contract: exits 0 on ANY error — parse, fs, validation.
 * Never blocks a Bash call. Session-id ALWAYS from payload, never from model output.
 */

import fs from "node:fs";
import path from "node:path";
import {
  isSafeFeatureId,
  isSafeSessionId,
  VALID_MODES,
  stateDirFor,
  mergeGateState,
  resetGateState,
} from "./lib/gate-lib.mjs";

// ---------------------------------------------------------------------------
// Pure decision layer — no I/O
// ---------------------------------------------------------------------------

/**
 * Unwraps the Bash result stdout from a hook payload.
 * PostToolUse(Bash) may deliver tool_response as a string OR as an object
 * like { stdout, stderr, interrupted }. Returns the trimmed stdout string,
 * or '' when no usable stdout is present. Never throws.
 *
 * @param {object} payload - The hook payload
 * @returns {string} The trimmed stdout, or '' if unavailable
 */
function unwrapStdout(payload) {
  const rawField = payload.tool_response ?? payload.tool_output ?? "";
  const raw =
    rawField && typeof rawField === "object" && !Array.isArray(rawField)
      ? (rawField.stdout ?? "")
      : rawField;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Parses the LAST JSON object line out of a multi-line stdout string.
 * Bash stdout may carry extra output (chained `&& echo ok`, an env proxy wrapping the
 * command, banners). Splits on newlines and scans from the last line backward, returning
 * the first line that JSON.parses to a plain (non-array, non-null) object — else null.
 * Never throws.
 *
 * @param {string} stdout - The unwrapped, trimmed stdout string
 * @returns {object|null} The last plain-object JSON line, or null when none parses
 */
function parseLastJsonObject(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) {
    return null;
  }
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.length === 0) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed;
    }
  }
  return null;
}

/**
 * Interprets a hook payload and returns an action descriptor.
 * Never throws. All validation lives here so decide() is unit-testable.
 *
 * @param {unknown} payload - The parsed hook payload
 * @returns {{ action: 'triage',         session_id: string, mode: string, feature_id: string }
 *         | { action: 'brainstorm-done', session_id: string }
 *         | { action: 'none' }}
 */
export function decide(payload) {
  // Must be a non-null plain object
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { action: "none" };
  }

  // Skip when inside a subagent (agent_id present = dispatched by entry-gate, not main loop)
  if (Object.prototype.hasOwnProperty.call(payload, "agent_id")) {
    return { action: "none" };
  }

  // session_id comes ONLY from the hook payload — never from model-supplied fields
  const session_id = payload.session_id;
  if (!isSafeSessionId(session_id)) {
    return { action: "none" };
  }

  // command string is the routing key
  const command = payload?.tool_input?.command;
  if (typeof command !== "string") {
    return { action: "none" };
  }

  // --- classify.mjs marker ---
  if (command.includes("classify.mjs")) {
    // tool_response holds the classify CLI's stdout (single JSON line).
    // May arrive as a string or as a { stdout, stderr } object — unwrap both.
    const responseStr = unwrapStdout(payload);

    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }

    const { mode, feature_id } = parsed;

    // Re-validate — never trust model output, even after classify ran
    if (!VALID_MODES.has(mode)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(feature_id)) {
      return { action: "none" };
    }

    // session_id is from payload above — any session_id in classify output is IGNORED
    return { action: "triage", session_id, mode, feature_id };
  }

  // --- mark.mjs brainstorm-done marker ---
  // Agent_id already checked above: reaching here means main-loop context only.
  // Substring match alone is forgeable (e.g. `grep brainstorm-done mark.mjs`),
  // so only honor it when the unwrapped stdout actually parses to the marker JSON.
  if (command.includes("mark.mjs") && command.includes("brainstorm-done")) {
    const responseStr = unwrapStdout(payload);

    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }
    if (parsed.marker !== "brainstorm-done") {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.feature_id)) {
      return { action: "none" };
    }

    return { action: "brainstorm-done", session_id };
  }

  return { action: "none" };
}

// ---------------------------------------------------------------------------
// Effect layer — performs the writes decided above
// ---------------------------------------------------------------------------

/**
 * Executes the action returned by decide().
 * Fail-open: all fs errors are swallowed — never propagated to the caller.
 *
 * @param {object} payload - The raw hook payload
 * @param {object} [opts] - Reserved for API extensibility (currently unused)
 */
export function handle(payload, opts = {}) {
  void opts; // reserved — tests use process.chdir isolation instead

  let decision;
  try {
    decision = decide(payload);
  } catch {
    return; // paranoid guard — decide() must never throw but just in case
  }

  if (decision.action === "triage") {
    const { session_id, mode, feature_id } = decision;
    const stateDir = stateDirFor(session_id);
    const triagePath = path.join(stateDir, "triage.json");
    const tmpPath = `${triagePath}.tmp`;

    const triage = {
      session_id,
      mode,
      feature_id,
      created_at: new Date().toISOString(),
    };

    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(triage, null, 2), "utf8");
      fs.renameSync(tmpPath, triagePath);
      // (Re)classify resets per-feature ceremony: overwrite gate-state with only the
      // new feature_id so brainstormed/adversary_fired never carry across features.
      resetGateState(session_id, feature_id);
    } catch {
      // fail-open: a failed write never surfaces as an error
    }
    return;
  }

  if (decision.action === "brainstorm-done") {
    // mergeGateState from gate-lib: read-merge-write atomic (temp→rename).
    // Never drops adversary_fired written by entry-gate on the allow path.
    mergeGateState(decision.session_id, { brainstormed: true });
    return;
  }

  // action === 'none': nothing to do
}

// ---------------------------------------------------------------------------
// CLI entry point — guarded so imports from tests do not trigger side effects
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  // Read stdin exactly once into a variable
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Malformed or empty payload — fail-open
    process.exit(0);
  }

  try {
    handle(payload);
  } catch {
    // Unexpected error — fail-open, never block a Bash call
  }

  process.exit(0);
}
