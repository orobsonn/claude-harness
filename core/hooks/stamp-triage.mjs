/**
 * @description PostToolUse(Bash) hook that stamps triage.json and gate-state.json
 * from trusted model-invoked marker commands.
 *
 * Recognises two command patterns via tool_input.command:
 *   - classify.mjs  → parse {mode, feature_id} from tool_response (stdout JSON),
 *                      re-validate via gate-lib, write atomic triage.json.
 *   - mark.mjs brainstorm-done → merge { brainstormed: true } into gate-state.json
 *                                 (main-loop only: skip when payload.agent_id present).
 *   - mark.mjs regate-pending / regate-passed → merge the per-task re-gate rail.
 *   - mark.mjs escalation-fallback → append the qualified task_id to escalation_fallback
 *                                 (the ticket the entry-gate consumes to allow a K=1 Claude hand).
 *   - mark.mjs hand-finished / capture-verified → the independent-capture rail: hand-finished
 *                                 records a finished hand; capture-verified only appends once that
 *                                 qualified id is already in hand_finished (never pre-authorizes).
 *
 * Fail-open contract: exits 0 on ANY error — parse, fs, validation.
 * Never blocks a Bash call. Session-id ALWAYS from payload, never from model output.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isSafeFeatureId,
  isSafeSessionId,
  VALID_MODES,
  stateDirFor,
  readGateState,
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
 * @returns {{ action: 'triage',          session_id: string, mode: string, feature_id: string }
 *         | { action: 'brainstorm-done', session_id: string }
 *         | { action: 'regate-pending',  session_id: string, task_id: string }  task_id is qualified `${feature_id}/${task_id}`
 *         | { action: 'regate-passed',   session_id: string, task_id: string }  task_id is qualified `${feature_id}/${task_id}`
 *         | { action: 'escalation-fallback', session_id: string, task_id: string }  task_id is qualified `${feature_id}/${task_id}`
 *         | { action: 'hand-finished',    session_id: string, task_id: string }  task_id is qualified `${feature_id}/${task_id}`
 *         | { action: 'capture-verified', session_id: string, task_id: string }  task_id is qualified `${feature_id}/${task_id}`
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
  // The parse-check guards against ACCIDENTAL substring matches (e.g. `grep brainstorm-done
  // mark.mjs` echoing the word) — it is NOT forgery-proof: an echo emitting the exact marker
  // JSON would pass. The real delivery safety is the entry-gate consumer, not this stamp.
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

  // --- mark.mjs regate-pending marker ---
  // Same parse-check pattern as brainstorm-done: it filters ACCIDENTAL substring matches,
  // not deliberate forgery (an echo of the exact marker JSON would pass). The deterministic
  // delivery safety lives in the entry-gate consumer that blocks the shipper on an unmatched
  // regate-pending — this stamp only records the marker.
  if (command.includes("mark.mjs") && command.includes("regate-pending")) {
    const responseStr = unwrapStdout(payload);
    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }
    if (parsed.marker !== "regate-pending") {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.task_id)) {
      return { action: "none" };
    }
    // Qualify the marker by feature so two features in the same session can never collide on
    // a bare task_id (e.g. both having a 'task-1'). The qualified id is opaque (never a path).
    return { action: "regate-pending", session_id, task_id: `${parsed.feature_id}/${parsed.task_id}` };
  }

  // --- mark.mjs regate-passed marker ---
  if (command.includes("mark.mjs") && command.includes("regate-passed")) {
    const responseStr = unwrapStdout(payload);
    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }
    if (parsed.marker !== "regate-passed") {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate-pending entry shape (collision-proof across features).
    return { action: "regate-passed", session_id, task_id: `${parsed.feature_id}/${parsed.task_id}` };
  }

  // --- mark.mjs escalation-fallback marker ---
  // Same stateless-mark + stamp-writer pattern: the ticket authorizes the entry-gate to allow a
  // K=1 Claude executor/sniper fallback dispatch from the main loop. Same parse-check caveat —
  // it filters ACCIDENTAL substring matches, not deliberate forgery; the deterministic safety is
  // the entry-gate consumer that denies main-loop Agent(executor|sniper) without a ticket.
  if (command.includes("mark.mjs") && command.includes("escalation-fallback")) {
    const responseStr = unwrapStdout(payload);
    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }
    if (parsed.marker !== "escalation-fallback") {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate entry shape (collision-proof across features).
    return { action: "escalation-fallback", session_id, task_id: `${parsed.feature_id}/${parsed.task_id}` };
  }

  // --- mark.mjs hand-config-error marker ---
  // The cheap-hand dispatch hit a PRE-SPAWN config error (no token, dirty baseline, gate not armed,
  // missing test) — NOT a genuine run failure. The orchestrator stamps this so the critical exception
  // is recorded in gate-state (survives compaction) and surfaced. It NEVER authorizes a Claude hand:
  // the entry-gate unlock requires an on-disk run-record with outcome FAILED, which a config error
  // never produces. Same parse-check caveat — filters accidental substring matches, not forgery.
  if (command.includes("mark.mjs") && command.includes("hand-config-error")) {
    const responseStr = unwrapStdout(payload);
    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }
    if (parsed.marker !== "hand-config-error") {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.task_id)) {
      return { action: "none" };
    }
    return { action: "hand-config-error", session_id, task_id: `${parsed.feature_id}/${parsed.task_id}` };
  }

  // --- mark.mjs hand-finished marker ---
  // Producer of the independent-capture rail: records that the cheap hand finished a task.
  // Same parse-check caveat — filters ACCIDENTAL substring matches, not deliberate forgery; the
  // deterministic capture safety lives in the entry-gate consumer (decideBash), not this stamp.
  if (command.includes("mark.mjs") && command.includes("hand-finished")) {
    const responseStr = unwrapStdout(payload);
    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }
    if (parsed.marker !== "hand-finished") {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate entry shape (collision-proof across features).
    return { action: "hand-finished", session_id, task_id: `${parsed.feature_id}/${parsed.task_id}` };
  }

  // --- mark.mjs capture-verified marker ---
  // Consumer-precondition of the independent-capture rail. Only stamped (in handle) when the
  // qualified id is ALREADY in hand_finished — a capture-verified must never pre-authorize an
  // un-finished hand (mirrors the regate-passed guard).
  if (command.includes("mark.mjs") && command.includes("capture-verified")) {
    const responseStr = unwrapStdout(payload);
    const parsed = parseLastJsonObject(responseStr);
    if (parsed === null) {
      return { action: "none" };
    }
    if (parsed.marker !== "capture-verified") {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(parsed.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate entry shape (collision-proof across features).
    return { action: "capture-verified", session_id, task_id: `${parsed.feature_id}/${parsed.task_id}` };
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
    const tmpPath = `${triagePath}.${process.pid}.tmp`;

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

  if (decision.action === "regate-pending") {
    // Append task_id to the regate_pending list (dedup — idempotent for the same task_id).
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.regate_pending) ? current.regate_pending : [];
    if (!existing.includes(decision.task_id)) {
      mergeGateState(decision.session_id, { regate_pending: [...existing, decision.task_id] });
    }
    return;
  }

  if (decision.action === "escalation-fallback") {
    // Append the qualified task_id to escalation_fallback (dedup — idempotent). Merge via
    // gate-lib so brainstormed/adversary_fired/regate_pending/regate_passed are never dropped.
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.escalation_fallback) ? current.escalation_fallback : [];
    if (!existing.includes(decision.task_id)) {
      mergeGateState(decision.session_id, { escalation_fallback: [...existing, decision.task_id] });
    }
    return;
  }

  if (decision.action === "hand-config-error") {
    // Append the qualified task_id to hand_config_error (dedup — idempotent). This is an AUDIT record
    // of a surfaced critical exception (pre-spawn config error); it NEVER authorizes a Claude hand —
    // the entry-gate unlock belt is an on-disk run-record with outcome FAILED, which this is not.
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.hand_config_error) ? current.hand_config_error : [];
    if (!existing.includes(decision.task_id)) {
      mergeGateState(decision.session_id, { hand_config_error: [...existing, decision.task_id] });
    }
    return;
  }

  if (decision.action === "regate-passed") {
    // A regate-passed only clears a re-gate that was actually raised: only append when the
    // task is currently in regate_pending. A regate-passed for a never-pending task is a
    // no-op — it must never pre-authorize a future (or forged) pending that hasn't run.
    const current = readGateState(decision.session_id);
    const pending = Array.isArray(current.regate_pending) ? current.regate_pending : [];
    if (!pending.includes(decision.task_id)) {
      return;
    }
    // Append task_id to the regate_passed list (dedup — idempotent for the same task_id).
    const existing = Array.isArray(current.regate_passed) ? current.regate_passed : [];
    if (!existing.includes(decision.task_id)) {
      mergeGateState(decision.session_id, { regate_passed: [...existing, decision.task_id] });
    }
    return;
  }

  if (decision.action === "hand-finished") {
    // Append the qualified task_id to hand_finished (dedup — idempotent). Merge via gate-lib so
    // brainstormed/adversary_fired/regate_pending/regate_passed/escalation_fallback are never dropped.
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.hand_finished) ? current.hand_finished : [];
    if (!existing.includes(decision.task_id)) {
      mergeGateState(decision.session_id, { hand_finished: [...existing, decision.task_id] });
    }
    return;
  }

  if (decision.action === "capture-verified") {
    // A capture-verified only counts once the hand actually finished: only append when the task is
    // currently in hand_finished. A capture-verified for a never-finished hand is a no-op — it must
    // never pre-authorize a future (or forged) capture that hasn't run (mirrors the regate-passed guard).
    const current = readGateState(decision.session_id);
    const finished = Array.isArray(current.hand_finished) ? current.hand_finished : [];
    if (!finished.includes(decision.task_id)) {
      return;
    }
    const existing = Array.isArray(current.capture_verified) ? current.capture_verified : [];
    if (!existing.includes(decision.task_id)) {
      mergeGateState(decision.session_id, { capture_verified: [...existing, decision.task_id] });
    }
    return;
  }

  // action === 'none': nothing to do
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
