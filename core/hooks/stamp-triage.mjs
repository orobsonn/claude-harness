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
 *   - mark.mjs fidelity-pass → the fidelity rail: appends the qualified <feature_id>/<task_id>
 *                                 to gate-state.fidelity_pass (append, dedup, idempotent). Consumed
 *                                 by entry-gate to gate spawn-hand.mjs dispatches and headless
 *                                 executor Agent dispatches.
 *   - spawn-hand.mjs pre-spawn config error → NOT a gate-state write. spawn-hand.mjs itself emits
 *                                 a structured {configError:true, reason, feature_id, task_id} JSON
 *                                 on exit 2 (see spawn-hand.mjs's exit-code contract) — this is the
 *                                 only trustworthy source for WHY a cheap-hand dispatch failed
 *                                 pre-spawn. The CLI entry point echoes that literal reason back as
 *                                 additionalContext so the orchestrator reports the REAL cause to the
 *                                 operator instead of composing its own explanation. Closes an incident
 *                                 where an agent fabricated a nonexistent "auto-mode data-exfiltration
 *                                 classifier" instead of reporting the real (and mundane) pre-spawn
 *                                 error verbatim.
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
  readHandRecord,
  markHandRecordCaptured,
} from "./lib/gate-lib.mjs";
import { appendEvent as defaultAppendEvent, readEvents as defaultReadEvents } from "../vps/obs-outbox.mjs";

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
 * Detects the REAL spawn-hand run-record on stdout — a genuine completed run, NOT the
 * {configError:true,...} pre-spawn shape. The run-record is built from the descriptor by
 * spawn-hand.mjs's runLiveDispatch (fields: model/scope_paths/frozen_paths/allowed_writes/
 * touchedPaths/exitCode/outcome/freezeCommitSha). It carries NO role field and NO top-level
 * task_id/feature_id. The distinguishing shape vs the config-error record is `outcome` (a plain
 * object) + `exitCode` (a number); config-error has neither. configError:true also excludes.
 * Never throws.
 *
 * @param {object|null} parsed - The last JSON object parsed from stdout
 * @returns {boolean} true when parsed is the real run-record shape
 */
function isRealRunRecord(parsed) {
  return (
    parsed !== null &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    parsed.configError !== true &&
    typeof parsed.outcome === "object" &&
    parsed.outcome !== null &&
    typeof parsed.exitCode === "number"
  );
}

/**
 * Extracts the --descriptor <path> value from a spawn-hand.mjs command string. The descriptor
 * path is the trustworthy source for task_id/feature_id/model (the stdout run-record carries none
 * of them). Returns null when no `--descriptor <path>` pair is present. Never throws.
 *
 * @param {string} command - The Bash command string from tool_input.command
 * @returns {string|null} the descriptor path, or null
 */
function extractDescriptorPath(command) {
  if (typeof command !== "string" || command.length === 0) {
    return null;
  }
  const tokens = command.split(/\s+/);
  const idx = tokens.indexOf("--descriptor");
  if (idx === -1 || idx + 1 >= tokens.length) {
    return null;
  }
  const descriptorPath = tokens[idx + 1];
  return descriptorPath.length > 0 ? descriptorPath : null;
}

/**
 * Counts JSON objects on stdout whose `marker` field equals `markerName`.
 * Scans ALL lines (not just the last), counting BEFORE any feature_id/task_id validation.
 * Returns both the count and, when count === 1, the sole matching object.
 * Never throws.
 *
 * @param {string} stdout - The unwrapped, trimmed stdout string
 * @param {string} markerName - The marker value to match (e.g. 'regate-passed')
 * @returns {{ count: number, sole: object|null }} count of matches, and the sole object when count === 1
 */
function countMarkerObjectsByName(stdout, markerName) {
  if (typeof stdout !== "string" || stdout.length === 0) {
    return { count: 0, sole: null };
  }
  const lines = stdout.split("\n");
  let count = 0;
  let sole = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      parsed.marker === markerName
    ) {
      count++;
      sole = parsed;
    }
  }
  return { count, sole: count === 1 ? sole : null };
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
 *         | { action: 'fidelity-pass',    session_id: string, task_id: string }  task_id is qualified `${feature_id}/${task_id}`
 *         | { action: 'plan-reviewed',  verdict: 'APPROVE'|'REVISE' }  observability-only (no gate-state write)
 *         | { action: 'task-executing', n: number, total: number }     observability-only (no gate-state write)
 *         | { action: 'final-review-done' }                           observability-only (no gate-state write)
 *         | { action: 'hand-ran', descriptorPath: string }              observability-only (no gate-state write);
 *                                 task/model are read from the --descriptor file at effect time
 *         | { action: 'marker-ambiguous' }
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

  // --- spawn-hand.mjs pre-spawn config error → deterministic nudge (not a gate-state write) ---
  // spawn-hand.mjs's own CLI entry point emits {configError:true, reason, feature_id, task_id} on
  // stdout when it exits 2 (a PRE-SPAWN check failed: no token, dirty baseline, gate not armed,
  // missing brief, diverged HEAD — see spawn-hand.mjs's exit-code contract comment). That JSON is
  // CODE output, not model prose — the only reason worth trusting. Read it here and hand it back as
  // additionalContext so the orchestrator quotes the real reason instead of inventing one.
  if (command.includes("spawn-hand.mjs")) {
    const responseStr = unwrapStdout(payload);
    const parsed = parseLastJsonObject(responseStr);
    if (
      parsed !== null &&
      parsed.configError === true &&
      typeof parsed.reason === "string" &&
      parsed.reason.length > 0
    ) {
      return {
        action: "hand-config-error-nudge",
        reason: parsed.reason,
        feature_id: typeof parsed.feature_id === "string" ? parsed.feature_id : null,
        task_id: typeof parsed.task_id === "string" ? parsed.task_id : null,
      };
    }
    // REAL run-record: a genuine completed run (the hand actually fired). The stdout record has
    // NO role field and NO top-level task_id/feature_id, so task/model are sourced from the
    // --descriptor file named in argv at effect time — never fabricated from stdout. The hook
    // appends a {type:'hand-ran', task, model} checkpoint to the observability outbox, closing
    // executor/sniper blindness (hands are Bash via spawn-hand, not Agent).
    if (isRealRunRecord(parsed)) {
      const descriptorPath = extractDescriptorPath(command);
      if (descriptorPath) {
        return { action: "hand-ran", descriptorPath };
      }
    }
    return { action: "none" };
  }

  // --- mark.mjs brainstorm-done marker ---
  // Agent_id already checked above: reaching here means main-loop context only.
  // Exactly-one marker scan: count JSON objects with marker==='brainstorm-done' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("brainstorm-done")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "brainstorm-done");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    return { action: "brainstorm-done", session_id };
  }

  // --- mark.mjs regate-pending marker ---
  // Exactly-one marker scan: count JSON objects with marker==='regate-pending' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("regate-pending")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "regate-pending");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(sole.task_id)) {
      return { action: "none" };
    }
    // Qualify the marker by feature so two features in the same session can never collide on
    // a bare task_id (e.g. both having a 'task-1'). The qualified id is opaque (never a path).
    return { action: "regate-pending", session_id, task_id: `${sole.feature_id}/${sole.task_id}` };
  }

  // --- mark.mjs regate-passed marker ---
  // Exactly-one marker scan: count JSON objects with marker==='regate-passed' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("regate-passed")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "regate-passed");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(sole.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate-pending entry shape (collision-proof across features).
    return { action: "regate-passed", session_id, task_id: `${sole.feature_id}/${sole.task_id}` };
  }

  // --- mark.mjs escalation-fallback marker ---
  // Exactly-one marker scan: count JSON objects with marker==='escalation-fallback' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("escalation-fallback")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "escalation-fallback");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(sole.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate entry shape (collision-proof across features).
    return { action: "escalation-fallback", session_id, task_id: `${sole.feature_id}/${sole.task_id}` };
  }

  // --- mark.mjs hand-config-error marker ---
  // Exactly-one marker scan: count JSON objects with marker==='hand-config-error' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("hand-config-error")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "hand-config-error");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(sole.task_id)) {
      return { action: "none" };
    }
    return { action: "hand-config-error", session_id, task_id: `${sole.feature_id}/${sole.task_id}` };
  }

  // --- mark.mjs hand-finished marker ---
  // Exactly-one marker scan: count JSON objects with marker==='hand-finished' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("hand-finished")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "hand-finished");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(sole.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate entry shape (collision-proof across features).
    return { action: "hand-finished", session_id, task_id: `${sole.feature_id}/${sole.task_id}` };
  }

  // --- mark.mjs capture-verified marker ---
  // Exactly-one marker scan: count JSON objects with marker==='capture-verified' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("capture-verified")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "capture-verified");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    if (!isSafeFeatureId(sole.task_id)) {
      return { action: "none" };
    }
    // Qualify by feature to match the regate entry shape (collision-proof across features).
    return { action: "capture-verified", session_id, task_id: `${sole.feature_id}/${sole.task_id}` };
  }

  // --- mark.mjs fidelity-pass marker ---
  // Exactly-one marker scan: count JSON objects with marker==='fidelity-pass' BEFORE
  // id validation. Zero → none; one → validate then proceed; two+ → marker-ambiguous.
  if (command.includes("mark.mjs") && command.includes("fidelity-pass")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "fidelity-pass");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    // IDs are correlation-only: require non-empty strings, not full kebab-case
    if (typeof sole.feature_id !== "string" || sole.feature_id.length === 0) {
      return { action: "none" };
    }
    if (typeof sole.task_id !== "string" || sole.task_id.length === 0) {
      return { action: "none" };
    }
    // Qualify by feature to match the other rail entry shapes (collision-proof across features).
    return { action: "fidelity-pass", session_id, task_id: `${sole.feature_id}/${sole.task_id}` };
  }

  // --- mark.mjs plan-reviewed marker (observability-only — NO gate-state write) ---
  // Exactly-one marker scan, mirroring the re-gate rail. task_id is OPTIONAL (the plan verdict is
  // feature-scoped); verdict must be APPROVE|REVISE. The stamp-triage hook appends a
  // {type:'plan-reviewed', verdict} checkpoint event to the run's observability outbox — the
  // deterministic producer for the plan-reviewer verdict checkpoint (no prose sourcing).
  if (command.includes("mark.mjs") && command.includes("plan-reviewed")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "plan-reviewed");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    if (sole.task_id !== undefined && sole.task_id !== null) {
      if (!isSafeFeatureId(sole.task_id)) {
        return { action: "none" };
      }
    }
    if (sole.verdict !== "APPROVE" && sole.verdict !== "REVISE") {
      return { action: "none" };
    }
    return { action: "plan-reviewed", verdict: sole.verdict };
  }

  // --- mark.mjs task-executing marker (observability-only — NO gate-state write) ---
  // Exactly-one marker scan. n/total must be positive integers. Appends a
  // {type:'task-executing', n, total} checkpoint event — the deterministic per-task-loop-top signal.
  if (command.includes("mark.mjs") && command.includes("task-executing")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "task-executing");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    const n = Number(sole.n);
    const total = Number(sole.total);
    if (!Number.isInteger(n) || n < 1) {
      return { action: "none" };
    }
    if (!Number.isInteger(total) || total < 1) {
      return { action: "none" };
    }
    return { action: "task-executing", n, total };
  }

  // --- mark.mjs final-review-done marker (observability-only — NO gate-state write) ---
  // Exactly-one marker scan, feature-scoped (no task_id). Appends a {type:'final-review-done'}
  // checkpoint event — the deterministic final-dual-review-join signal.
  if (command.includes("mark.mjs") && command.includes("final-review-done")) {
    const responseStr = unwrapStdout(payload);
    const { count, sole } = countMarkerObjectsByName(responseStr, "final-review-done");
    if (count === 0) {
      return { action: "none" };
    }
    if (count >= 2) {
      return { action: "marker-ambiguous" };
    }
    if (!isSafeFeatureId(sole.feature_id)) {
      return { action: "none" };
    }
    return { action: "final-review-done" };
  }

  return { action: "none" };
}

// ---------------------------------------------------------------------------
// Effect layer — performs the writes decided above
// ---------------------------------------------------------------------------

/**
 * @description Appends one checkpoint event to the run's observability outbox (the
 * obs-<issue>.events.jsonl derived from the meta path). STRICTLY ADDITIVE + FAIL-OPEN:
 * a cheap no-op when HARNESS_OBSERVABILITY_RUN_PATH is unset or points at a nonexistent
 * meta (existsSync-guarded), and an appendEvent that throws is swallowed — it NEVER blocks
 * the triage.json / gate-state write. Performs NO fetch. The session-side appendEvent is
 * disjoint from the cron-side meta rewrite (no two-writer race).
 *
 * Append-if-absent (`opts.dedupeFn`): the SAME outbox is shared by the main loop and every
 * dispatched subagent (they inherit HARNESS_OBSERVABILITY_RUN_PATH), so an event emitted once per
 * session — e.g. `pipeline-type`, or a per-task `regate-pending` — would otherwise be written N times
 * (once per subagent's own triage/mark), spamming the Telegram drain. When `dedupeFn` is supplied the
 * current outbox is read and the append is skipped if any existing event matches. BEST-EFFORT: the
 * read→append is not atomic, so two writers racing in the same instant may both observe "absent" and
 * both append — fail-open, the cost is at most one duplicate feed line, never a blocked pipeline.
 * @param {object} event - The checkpoint event to append.
 * @param {(metaPath: string, event: object) => void} appendFn - obs-outbox appendEvent seam.
 * @param {{ dedupeFn?: (existing: object) => boolean, readEventsFn?: (metaPath: string) => object[] }} [opts]
 * @returns {void}
 */
function obsAppend(event, appendFn, opts = {}) {
  const metaPath = process.env.HARNESS_OBSERVABILITY_RUN_PATH;
  if (typeof metaPath !== "string" || metaPath.length === 0) {
    return;
  }
  try {
    if (!fs.existsSync(metaPath)) {
      return;
    }
    if (typeof opts.dedupeFn === "function") {
      const readFn = opts.readEventsFn || defaultReadEvents;
      const existing = readFn(metaPath) || [];
      if (existing.some((e) => e && opts.dedupeFn(e))) {
        return;
      }
    }
    appendFn(metaPath, event);
  } catch {
    // fail-open: an outbox append never blocks the gate-state write / triage persist
  }
}

/**
 * @description Reads the --descriptor file named in the spawn-hand command argv — the
 * trustworthy source for task_id/model (the stdout run-record carries neither; it has no role
 * field either). Returns the parsed descriptor object, or null on any missing/malformed/absent
 * path. role is honored only when the descriptor carries a valid executor|sniper string; it is
 * otherwise omitted, NEVER fabricated. Never throws.
 * @param {string|null|undefined} descriptorPath
 * @returns {{ task_id: string, model: string, role?: string }|null}
 */
function readDescriptorForHandRan(descriptorPath) {
  if (typeof descriptorPath !== "string" || descriptorPath.length === 0) {
    return null;
  }
  try {
    if (!fs.existsSync(descriptorPath)) {
      return null;
    }
    const raw = fs.readFileSync(descriptorPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    if (typeof parsed.task_id !== "string" || parsed.task_id.length === 0) {
      return null;
    }
    if (typeof parsed.model !== "string" || parsed.model.length === 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Executes the action returned by decide().
 * Fail-open: all fs errors are swallowed — never propagated to the caller.
 *
 * Returns a descriptor object so the CLI entry point can build at most one
 * hookSpecificOutput nudge (read-back-failed). Returns undefined for actions
 * that do not attempt a gate-state write (triage, none, no-op guards, idempotent skips,
 * and the observability-only markers plan-reviewed / task-executing / final-review-done).
 *
 * @param {object} payload - The raw hook payload
 * @param {object} [opts] - Extensibility seam for fault injection.
 *   opts.mergeGateStateFn — replacement for mergeGateState (test seam for root-proof
 *     read-back fault injection). When absent, the real mergeGateState is used.
 *   opts.appendEventFn — replacement for obs-outbox appendEvent (test seam for the
 *     fail-open append contract). When absent, the real appendEvent is used.
 * @returns {{ readBackOk: boolean } | undefined}
 */
export function handle(payload, opts = {}) {
  const mergeFn = opts.mergeGateStateFn || mergeGateState;
  const markCapturedFn = opts.markHandRecordCapturedFn || markHandRecordCaptured;
  const appendEventFn = opts.appendEventFn || defaultAppendEvent;

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
    // Observability: append a {type:'pipeline-type', mode} checkpoint AFTER the triage write +
    // gate-state reset so an appendEvent failure (swallowed by obsAppend) NEVER blocks them.
    obsAppend({ type: "pipeline-type", mode }, appendEventFn, {
      dedupeFn: (e) => e.type === "pipeline-type" && e.mode === mode,
    });
    return;
  }

  if (decision.action === "brainstorm-done") {
    // mergeGateState from gate-lib: read-merge-write atomic (temp→rename).
    // Never drops adversary_fired written by entry-gate on the allow path.
    mergeFn(decision.session_id, { brainstormed: true });
    // Read-back: presence-check that brainstormed landed
    const after = readGateState(decision.session_id);
    return { readBackOk: after.brainstormed === true };
  }

  if (decision.action === "regate-pending") {
    // Observability + audit: the deterministic producer for #ac-3.1 (unmatched regate-pending).
    // `matched:false` records it in the JSONL audit trail. NOTE: this is AUDIT-ONLY — the Telegram
    // drain suppresses regate-pending from the curated feed (it is not a milestone the operator
    // wants); the delivery block stays gate-state-enforced, independent of any ping. Appended BEFORE
    // the gate-state stamp; obsAppend swallows any throw so the regate-pending stamping below is
    // untouched. The bare task_id (un-qualified) is the signal payload — the qualified id stays in
    // gate-state.
    const bareTaskId = decision.task_id.split("/").pop();
    obsAppend({ type: "regate-pending", task: bareTaskId, matched: false }, appendEventFn, {
      dedupeFn: (e) => e.type === "regate-pending" && e.task === bareTaskId,
    });

    // Append task_id to the regate_pending list (dedup — idempotent for the same task_id).
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.regate_pending) ? current.regate_pending : [];
    if (!existing.includes(decision.task_id)) {
      mergeFn(decision.session_id, { regate_pending: [...existing, decision.task_id] });
      // Read-back: presence-check that the qualified task_id landed
      const after = readGateState(decision.session_id);
      const pending = Array.isArray(after.regate_pending) ? after.regate_pending : [];
      return { readBackOk: pending.includes(decision.task_id) };
    }
    return; // idempotent already-present — no write attempted, no read-back
  }

  if (decision.action === "escalation-fallback") {
    // Append the qualified task_id to escalation_fallback (dedup — idempotent). Merge via
    // gate-lib so brainstormed/adversary_fired/regate_pending/regate_passed are never dropped.
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.escalation_fallback) ? current.escalation_fallback : [];
    if (!existing.includes(decision.task_id)) {
      mergeFn(decision.session_id, { escalation_fallback: [...existing, decision.task_id] });
      // Read-back: presence-check that the qualified task_id landed
      const after = readGateState(decision.session_id);
      const fb = Array.isArray(after.escalation_fallback) ? after.escalation_fallback : [];
      return { readBackOk: fb.includes(decision.task_id) };
    }
    return; // idempotent already-present — no write attempted, no read-back
  }

  if (decision.action === "hand-config-error") {
    // Append the qualified task_id to hand_config_error (dedup — idempotent). This is an AUDIT record
    // of a surfaced critical exception (pre-spawn config error); it NEVER authorizes a Claude hand —
    // the entry-gate unlock belt is an on-disk run-record with outcome FAILED, which this is not.
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.hand_config_error) ? current.hand_config_error : [];
    if (!existing.includes(decision.task_id)) {
      mergeFn(decision.session_id, { hand_config_error: [...existing, decision.task_id] });
      // Read-back: presence-check that the qualified task_id landed
      const after = readGateState(decision.session_id);
      const hce = Array.isArray(after.hand_config_error) ? after.hand_config_error : [];
      return { readBackOk: hce.includes(decision.task_id) };
    }
    return; // idempotent already-present — no write attempted, no read-back
  }

  if (decision.action === "regate-passed") {
    // A regate-passed only clears a re-gate that was actually raised: only append when the
    // task is currently in regate_pending. A regate-passed for a never-pending task is a
    // no-op — it must never pre-authorize a future (or forged) pending that hasn't run.
    const current = readGateState(decision.session_id);
    const pending = Array.isArray(current.regate_pending) ? current.regate_pending : [];
    if (!pending.includes(decision.task_id)) {
      return; // intentional no-op guard — no read-back
    }
    // Append task_id to the regate_passed list (dedup — idempotent for the same task_id).
    const existing = Array.isArray(current.regate_passed) ? current.regate_passed : [];
    if (!existing.includes(decision.task_id)) {
      mergeFn(decision.session_id, { regate_passed: [...existing, decision.task_id] });
      // Read-back: presence-check that the qualified task_id landed in regate_passed
      const after = readGateState(decision.session_id);
      const passed = Array.isArray(after.regate_passed) ? after.regate_passed : [];
      return { readBackOk: passed.includes(decision.task_id) };
    }
    return; // idempotent already-present — no write attempted, no read-back
  }

  if (decision.action === "hand-finished") {
    // Append the qualified task_id to hand_finished (dedup — idempotent). Merge via gate-lib so
    // brainstormed/adversary_fired/regate_pending/regate_passed/escalation_fallback are never dropped.
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.hand_finished) ? current.hand_finished : [];
    if (!existing.includes(decision.task_id)) {
      mergeFn(decision.session_id, { hand_finished: [...existing, decision.task_id] });
      // Read-back: presence-check that the qualified task_id landed
      const after = readGateState(decision.session_id);
      const hf = Array.isArray(after.hand_finished) ? after.hand_finished : [];
      return { readBackOk: hf.includes(decision.task_id) };
    }
    return; // idempotent already-present — no write attempted, no read-back
  }

  if (decision.action === "capture-verified") {
    // A capture-verified only counts once the hand actually finished: only append when the task is
    // currently in hand_finished. A capture-verified for a never-finished hand is a no-op — it must
    // never pre-authorize a future (or forged) capture that hasn't run (mirrors the regate-passed guard).
    const current = readGateState(decision.session_id);
    const finished = Array.isArray(current.hand_finished) ? current.hand_finished : [];
    if (!finished.includes(decision.task_id)) {
      return; // intentional no-op guard — no read-back
    }
    // Second, independent guard: a real on-disk run-record must exist for this qualified id.
    // hand_finished is a manually-stamped array (prose-driven, proven skippable); the run-record
    // is written unconditionally by spawn-hand.mjs's runLiveDispatch, so requiring BOTH means a
    // forged marker with no genuine dispatch behind it stamps nothing anywhere, ever.
    if (readHandRecord(decision.task_id) === null) {
      return; // intentional no-op guard — no read-back
    }
    // Durable stamp runs unconditionally AFTER both guards pass — it is idempotent (overwrites
    // the timestamp) so it self-heals a prior partial failure on every retry.
    const recordOk = markCapturedFn(decision.task_id, new Date().toISOString());
    const existing = Array.isArray(current.capture_verified) ? current.capture_verified : [];
    if (!existing.includes(decision.task_id)) {
      mergeFn(decision.session_id, { capture_verified: [...existing, decision.task_id] });
      // Read-back: presence-check that the qualified task_id landed in capture_verified
      const after = readGateState(decision.session_id);
      const cv = Array.isArray(after.capture_verified) ? after.capture_verified : [];
      const cvOk = cv.includes(decision.task_id);
      return { readBackOk: cvOk && recordOk };
    }
    // Idempotent already-present: the durable stamp still ran above, so fold its result into
    // readBackOk — if the durable write is still failing, readBackOk:false fires the loud nudge.
    return { readBackOk: recordOk };
  }

  if (decision.action === "fidelity-pass") {
    // Append the qualified task_id to fidelity_pass (dedup — idempotent). Merge via gate-lib so
    // no other gate-state fields are dropped. This records that the test-author confirmed a red
    // locked test exists for this task — the executor cheap-hand and headless executor are gated
    // on this stamp before they can be dispatched.
    const current = readGateState(decision.session_id);
    const existing = Array.isArray(current.fidelity_pass) ? current.fidelity_pass : [];
    if (!existing.includes(decision.task_id)) {
      mergeFn(decision.session_id, { fidelity_pass: [...existing, decision.task_id] });
      // Read-back: presence-check that the qualified task_id landed
      const after = readGateState(decision.session_id);
      const fp = Array.isArray(after.fidelity_pass) ? after.fidelity_pass : [];
      return { readBackOk: fp.includes(decision.task_id) };
    }
    return; // idempotent already-present — no write attempted, no read-back
  }

  // --- observability-only markers: append the checkpoint event, no gate-state write ---
  if (decision.action === "plan-reviewed") {
    // Dedupe against the obs-eye-append producer (which appends plan-reviewed deterministically when
    // the plan-reviewer subagent returns): the orchestrator ALSO runs `mark.mjs plan-reviewed` per
    // SKILL.md, so without this every review would emit TWO identical feed lines. Keyed on
    // (type, verdict) so a genuine second review after a REVISE→re-plan (different verdict) still
    // gets through, while the same-verdict duplicate is suppressed.
    obsAppend({ type: "plan-reviewed", verdict: decision.verdict }, appendEventFn, {
      dedupeFn: (e) => e.type === "plan-reviewed" && e.verdict === decision.verdict,
    });
    return;
  }

  if (decision.action === "task-executing") {
    obsAppend({ type: "task-executing", n: decision.n, total: decision.total }, appendEventFn);
    return;
  }

  if (decision.action === "final-review-done") {
    obsAppend({ type: "final-review-done" }, appendEventFn);
    return;
  }

  // --- observability-only: the spawn-hand hand actually ran (a genuine completed run) ---
  // task/model come from the --descriptor file (the trustworthy source); the stdout run-record
  // has NO role/task_id field, so role is honored only when the descriptor carries a valid
  // executor|sniper value — otherwise omitted, never fabricated. No gate-state write, no fetch.
  if (decision.action === "hand-ran") {
    const descriptor = readDescriptorForHandRan(decision.descriptorPath);
    if (descriptor) {
      const event = { type: "hand-ran", task: descriptor.task_id, model: descriptor.model };
      if (descriptor.role === "executor" || descriptor.role === "sniper") {
        event.role = descriptor.role;
      }
      obsAppend(event, appendEventFn);
    }
    return;
  }

  // action === 'none', 'marker-ambiguous', 'hand-config-error-nudge': nothing to persist
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

  let handleResult;
  try {
    handleResult = handle(payload);
  } catch {
    // Unexpected error — fail-open, never block a Bash call
  }

  // Build at most ONE hookSpecificOutput across the 3 mutually-exclusive nudges.
  // Precedence: hand-config-error → marker-ambiguous → read-back-failed.
  let nudge = null;
  try {
    const decision = decide(payload);
    if (decision.action === "hand-config-error-nudge") {
      const qualifiedId =
        decision.feature_id && decision.task_id ? `${decision.feature_id}/${decision.task_id}` : "this task";
      nudge = {
        hookEventName: "PostToolUse",
        additionalContext:
          `spawn-hand.mjs reported a PRE-SPAWN CONFIG ERROR for ${qualifiedId} — this is not a ` +
          `network policy, sandbox, or Auto Mode block. The real, verbatim reason: "${decision.reason}". ` +
          "Surface this exact reason to the operator. Do not invent an alternative explanation.",
      };
    } else if (decision.action === "marker-ambiguous") {
      nudge = {
        hookEventName: "PostToolUse",
        additionalContext:
          "marker shadowed/duplicated — run mark.mjs alone. " +
          "Multiple marker JSON objects with the same marker name were detected on stdout. " +
          "The stamp was NOT persisted. Re-run the mark.mjs command in isolation to resolve.",
      };
    } else if (handleResult && handleResult.readBackOk === false) {
      nudge = {
        hookEventName: "PostToolUse",
        additionalContext:
          "read-back failed after gate-state write — the marker was processed but the " +
          "post-write presence check did not confirm the expected id landed in gate-state.json. " +
          "Re-run the mark.mjs command to retry the persist.",
      };
    }
  } catch {
    // fail-open — never block a Bash call over a nudge
  }

  if (nudge) {
    try {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: nudge }));
    } catch {
      // fail-open
    }
  }

  process.exit(0);
}
