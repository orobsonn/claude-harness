/**
 * @description Shared hook library for deterministic entry-gate.
 * Two groups of exports, both Node-builtins-only, no top-level side effects:
 *   (1) Pure validators/helpers — isSafeFeatureId, VALID_MODES, isDeliveryRole,
 *       stateDirFor, gateStatePathFor, isExpired. No I/O.
 *   (2) Gate-state I/O — readGateState (read-or-{}), mergeGateState (read-merge-write
 *       atomic). Shared by stamp-triage and entry-gate so the atomic-merge strategy
 *       is identical in both writers and adversary_fired/brainstormed can never drop
 *       each other.
 */

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseAbsolutionEntry,
  absolutionPrefix,
  matchesAbsolution,
} from "../../shared/lib/absolution.mjs";

export { parseAbsolutionEntry, absolutionPrefix, matchesAbsolution };

/**
 * Kebab-case token pattern: lowercase alphanumeric segments separated by hyphens.
 * Rejects path separators, uppercase, underscores — no path traversal.
 */
const SAFE_FEATURE_ID_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FEATURE_ID_MAX_LENGTH = 64;

/**
 * Validates that a feature_id is safe: kebab-case, ≤64 chars, no path traversal.
 * @param {unknown} value - The value to test
 * @returns {boolean} true if value is a string matching kebab-case and length cap, false otherwise
 */
export function isSafeFeatureId(value) {
  if (typeof value !== "string" || value.length === 0) {
    return false;
  }
  if (value.length > FEATURE_ID_MAX_LENGTH) {
    return false;
  }
  return SAFE_FEATURE_ID_REGEX.test(value);
}

/**
 * Validates that a session_id is safe: non-empty string of alphanumerics, underscores, or
 * hyphens only. Rejects path separators and dots that could cause path traversal.
 * @param {unknown} value - The value to test
 * @returns {boolean} true iff value is a string matching /^[A-Za-z0-9_-]+$/, false otherwise
 */
export function isSafeSessionId(value) {
  return typeof value === "string" && value.length > 0 && /^[A-Za-z0-9_-]+$/.test(value);
}

/**
 * Set of valid classification modes (UPPERCASE vocabulary).
 */
export const VALID_MODES = new Set(["no-ceremony", "QUICK", "LIGHT", "FULL"]);

/**
 * The 9 delivery roles that are gated by the entry-gate.
 */
const DELIVERY_ROLES = new Set([
  "planner",
  "executor",
  "compliance",
  "adversary",
  "sniper",
  "security",
  "harvester",
  "shipper",
  "plan-reviewer",
]);

/**
 * Strips a leading namespace prefix from a subagent_type so plugin-distributed roles
 * compare equal to bare roles (e.g. 'harness:planner' → 'planner'). Returns the segment
 * after the last ':', or the value itself when there is no ':'. Non-strings pass through.
 * @param {unknown} subagentType - The subagent_type to normalize
 * @returns {unknown} The bare role segment, or the original value when not a namespaced string
 */
export function bareRole(subagentType) {
  if (typeof subagentType !== "string" || !subagentType.includes(":")) {
    return subagentType;
  }
  return subagentType.slice(subagentType.lastIndexOf(":") + 1);
}

/**
 * Checks if a subagent_type is a delivery role (gated by entry-gate).
 * Strips a leading namespace prefix (e.g. 'harness:planner' → 'planner') before lookup so
 * plugin-distributed roles still gate correctly.
 * Non-delivery roles (general-purpose, Explore, claude, etc.) are always allowed.
 * @param {unknown} subagentType - The subagent_type to check
 * @returns {boolean} true if the type is a delivery role, false otherwise
 */
export function isDeliveryRole(subagentType) {
  // Strip namespace prefix so plugin-distributed roles (e.g. 'harness:planner') still gate.
  const bare = bareRole(subagentType);
  return typeof bare === "string" && DELIVERY_ROLES.has(bare);
}

/**
 * Builds the canonical session-keyed state directory path.
 * Ephemeral session state lives under a dotted `.state/` subdir so the operator
 * browsing `.claude/plans/` sees only the readable per-feature plan dirs, never the
 * opaque session ids. The durable plan stays keyed by feature_id at the plans root.
 * @param {string} sessionId - The session identifier (e.g., 'ses_abc123')
 * @returns {string} path ending with '.claude/plans/.state/<sessionId>'
 */
export function stateDirFor(sessionId) {
  return `.claude/plans/.state/${sessionId}`;
}

/**
 * Builds the canonical path to a cheap-hand run-record. The PRODUCER is `runLiveDispatch`
 * (spawn-hand.mjs), which writes a token-free record keyed by feature, role, and task id
 * under this dir; the CONSUMER is the entry-gate hand-routing branch, which reads the record as
 * durable evidence (real exitCode + lockedTestExitCode from the independent capture)
 * that authorizes a Claude hand escape. The qualifiedId is the gate-state shape `feature_id/task_id`;
 * the path adds the trusted dispatch role as its own directory segment.
 * @param {string} qualifiedId - `${feature_id}/${task_id}`
 * @param {"executor"|"sniper"} role - The hand role that owns this record.
 * @returns {string|null} path to the run-record JSON, relative to process.cwd(), or null for an invalid role
 */
export function handRecordPathFor(qualifiedId, role) {
  if (role !== "executor" && role !== "sniper") return null;
  const separatorIndex = String(qualifiedId).indexOf("/");
  const featureId = separatorIndex === -1 ? String(qualifiedId) : qualifiedId.slice(0, separatorIndex);
  const taskId = separatorIndex === -1 ? "" : qualifiedId.slice(separatorIndex + 1);
  return path.join(".claude/plans/.state/hand-records", featureId, role, `${taskId}.json`);
}

/**
 * Reads and parses the on-disk run-record for a qualified task id.
 * Returns null on missing file, unparseable content, or any fs error — never throws
 * (fail-closed consumers treat a missing/garbage record as "no genuine failure evidence").
 * @param {string} qualifiedId - `${feature_id}/${task_id}`
 * @param {"executor"|"sniper"} role - The hand role that owns this record.
 * @returns {object|null} Parsed run-record, or null on any error
 */
export function readHandRecord(qualifiedId, role) {
  try {
    const recordPath = handRecordPathFor(qualifiedId, role);
    if (!recordPath) return null;
    const raw = fs.readFileSync(recordPath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Lists every on-disk run-record for a feature. Reads the feature's hand-records directory
 * directly (bounded to one feature, never a repo-wide glob) so the delivery gate's real-file
 * cross-check stays cheap regardless of how many features have ever run.
 * Returns [] on a missing directory or any fs error — never throws.
 * @param {string} featureId - The feature_id (unqualified — no task segment)
 * @returns {Array<{taskId: string, role?: "executor"|"sniper", record?: object, identityError?: string}>}
 */
export function listHandRecordsForFeature(featureId) {
  // Defense in depth: every current caller already validates featureId upstream (gate-state's
  // feature_id is only ever written via the isSafeFeatureId-gated triage/reclassify path), but
  // this export has no control over future callers — guard here too so a path-traversal
  // featureId (e.g. "../../../tmp") can never escape the hand-records directory via this function.
  if (!isSafeFeatureId(featureId)) {
    return [];
  }
  const dir = path.join(".claude/plans/.state/hand-records", String(featureId));
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const results = [];
  // A flat record belongs to the pre-role layout. Do not reuse it as evidence: it
  // may be an unstamped DONE or a violation that the new layout would otherwise
  // hide. Surface it as an identity error so the delivery rail fails closed until
  // the hand is re-dispatched into a role-scoped record.
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    results.push({
      taskId: entry.slice(0, -".json".length) || "unknown",
      identityError: "legacy flat hand-record; re-dispatch the hand to create role-scoped evidence",
    });
  }
  for (const role of ["executor", "sniper"]) {
    const roleDir = path.join(dir, role);
    let roleEntries;
    try {
      roleEntries = fs.readdirSync(roleDir);
    } catch {
      continue;
    }
    for (const entry of roleEntries) {
      if (!entry.endsWith(".json")) continue;
      const taskId = entry.slice(0, -".json".length);
      const record = readHandRecord(`${featureId}/${taskId}`, role);
      if (record !== null) {
        results.push({ taskId, role, record });
      }
    }
  }
  return results;
}

/**
 * Stamps `capturedVerifiedAt` onto the real on-disk run-record for a qualified task id.
 * No-op (returns false, writes nothing) when the record does not exist — this is the
 * anti-forgery guard: a marker for a dispatch that never happened has no file to stamp.
 * Never throws. Atomic write (temp -> rename), mirrors mergeGateState's strategy.
 * @param {string} qualifiedId - `${feature_id}/${task_id}`
 * @param {"executor"|"sniper"} role - The hand role that owns this record.
 * @param {string} timestampIso - ISO-8601 timestamp string
 * @returns {boolean} true on success, false when the record is missing or the write fails
 */
export function markHandRecordCaptured(qualifiedId, role, timestampIso) {
  // Defense in depth: reject a qualifiedId whose feature/task segments are not both safe
  // kebab-case ids BEFORE doing anything — same rationale as listHandRecordsForFeature.
  const separatorIndex = String(qualifiedId).indexOf("/");
  const featureIdPart = separatorIndex === -1 ? String(qualifiedId) : qualifiedId.slice(0, separatorIndex);
  const taskIdPart = separatorIndex === -1 ? "" : qualifiedId.slice(separatorIndex + 1);
  if (!isSafeFeatureId(featureIdPart) || !isSafeFeatureId(taskIdPart)) {
    return false;
  }
  const record = readHandRecord(qualifiedId, role);
  if (record === null) {
    return false;
  }
  try {
    const merged = { ...record, capturedVerifiedAt: timestampIso };
    const targetPath = handRecordPathFor(qualifiedId, role);
    if (!targetPath) return false;
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks if a file (by mtime) has expired beyond a maximum age.
 * @param {number} mtimeMs - File modification time in milliseconds
 * @param {number} nowMs - Current time in milliseconds
 * @param {number} maxAgeDays - Maximum age in days
 * @returns {boolean} true if the file is older than maxAgeDays, false otherwise
 */
export function isExpired(mtimeMs, nowMs, maxAgeDays) {
  const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
  return nowMs - mtimeMs > maxAgeMs;
}

// ---------------------------------------------------------------------------
// Sha-qualified absolutions — shared by stamp-triage (STAMPS the sha) and
// entry-gate/reinject-state (READ validity). An absolution entry is stored as
// `<feature>/<task>@<sha>`; the obligation it clears stays UNqualified
// `<feature>/<task>` (obligations survive across shas, absolutions do not).
// ---------------------------------------------------------------------------

/**
 * @description Best-effort current-HEAD sha reader for sha-qualifying an absolution at stamp time.
 * Returns the trimmed `git rev-parse HEAD` output, or null on ANY git/infra error — so a non-git
 * environment (or a git failure) makes the caller fall back to an UNqualified stamp. An unqualified
 * absolution is treated as legacy/absent by the reader (fail-safe: absent = blocks delivery, never
 * falsely clears). Mirrors entry-gate's defaultHeadSha approach; exported so stamp-triage reuses it.
 * @returns {string|null}
 */
export function currentHeadSha() {
  try {
    return (
      execFileSync("git", ["rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * @description True iff an absolution array entry is sha-QUALIFIED (`<feature>/<task>@<sha>` with a
 * non-empty prefix and sha). The purge belt in resetGateState uses it to DROP unqualified
 * (pre-migration/legacy) absolutions so a stale unqualified entry cannot clear an obligation for the
 * first re-dispatch. parseAbsolutionEntry / absolutionPrefix / matchesAbsolution are 1:1 re-exports
 * from core/shared/lib/absolution.mjs (shared is source of truth).
 * @param {unknown} entry
 * @returns {boolean}
 */
function isShaQualified(entry) {
  return parseAbsolutionEntry(entry) !== null;
}

// ---------------------------------------------------------------------------
// Gate-state I/O — shared by stamp-triage (writes brainstormed) and
// entry-gate (writes adversary_fired). Single implementation guarantees the
// read-merge-write atomic strategy is identical in both writers.
// ---------------------------------------------------------------------------

/**
 * Builds the canonical path to gate-state.json for a session.
 * @param {string} sessionId - The session identifier (e.g., 'ses_abc123')
 * @returns {string} path to gate-state.json, relative to process.cwd()
 */
export function gateStatePathFor(sessionId) {
  return path.join(stateDirFor(sessionId), "gate-state.json");
}

/**
 * Reads and parses gate-state.json for a session.
 * Returns {} on missing file, unparseable content, non-object value, or any fs error.
 * Never throws — fail-open consumers depend on this.
 * @param {string} sessionId - The session identifier
 * @returns {object} Parsed gate-state object, or {} on any error
 */
export function readGateState(sessionId) {
  try {
    const raw = fs.readFileSync(gateStatePathFor(sessionId), "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

/**
 * Reads current gate state, shallow-merges patch over it, writes atomically
 * (write to <path>.tmp then fs.renameSync to target; mkdir -p the dir first).
 * Temp→rename is atomic: no partial file observed. The read-merge-write cycle is
 * interleave-safe for SERIAL hook invocations (Claude Code fires sequentially), not
 * concurrent processes; adversary_fired and brainstormed never drop in practice.
 * Never throws. Returns true on success, false on any error.
 * @param {string} sessionId - The session identifier
 * @param {object} patch - Fields to shallow-merge into the gate state
 * @returns {boolean} true on success, false on any error
 */
export function mergeGateState(sessionId, patch) {
  try {
    const current = readGateState(sessionId);
    const merged = { ...current, ...patch };
    const targetPath = gateStatePathFor(sessionId);
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    fs.mkdirSync(stateDirFor(sessionId), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Atomically OVERWRITES gate-state.json on (re)classify, discarding the per-feature
 * ceremony flags (brainstormed/adversary_fired) so they never carry stale across features.
 *
 * Delivery-obligation rail invariant: regate_pending/regate_passed are preserved
 * UNCONDITIONALLY — including across a genuine feature SWITCH. They are a SESSION-level delivery
 * obligation on the un-pushed branch (a HIGH sniper fix still awaiting its re-gate), so a grave
 * fix on feature A must never ship just because the session reclassified to feature B.
 * hand_finished/capture_verified are preserved alongside them for shape stability, but they no
 * longer gate delivery on this lane (the array-diff rail was removed from entry-gate — capture is
 * guarded by the real-file rail instead), so preserving them across a reclassify is no longer what
 * stops a re-triage from laundering the capture rail. What stops it is that the real-file rail
 * reads run-records keyed by feature, written by spawn-hand's own code.
 * Only the per-feature ceremony flags (brainstormed/adversary_fired) are discarded on reclassify.
 *
 * Writes to <path>.<pid>.tmp then fs.renameSync to target (atomic; pid-suffixed temp
 * avoids concurrent-process collision). Never throws. Returns true on success, false otherwise.
 * @param {string} sessionId - The session identifier
 * @param {string} featureId - The feature_id to stamp
 * @returns {boolean} true on success, false on any error
 */
export function resetGateState(sessionId, featureId) {
  try {
    const current = readGateState(sessionId);
    const next = { feature_id: featureId };
    // Obligations survive a reclassify VERBATIM (they are unqualified and must outlive shas).
    if (Array.isArray(current.regate_pending)) next.regate_pending = current.regate_pending;
    if (Array.isArray(current.hand_finished)) next.hand_finished = current.hand_finished;
    // Purge belt (#ac-2.2): the preserved ABSOLUTION arrays drop any UNqualified (pre-migration,
    // no-@sha) entry, so an old-schema gate-state cannot pass a stale unqualified absolution to the
    // first re-dispatch. (Primary rail = the reader ignoring unqualified/non-ancestor; this is the belt.)
    if (Array.isArray(current.regate_passed)) next.regate_passed = current.regate_passed.filter(isShaQualified);
    if (Array.isArray(current.capture_verified)) next.capture_verified = current.capture_verified.filter(isShaQualified);
    // Preserve the plan-review round counter across a re-triage/compaction-resume so a
    // reclassify of the SAME session cannot launder the counter back to 0 and dodge the ceiling.
    if (Number.isInteger(current.plan_review_count)) next.plan_review_count = current.plan_review_count;
    const targetPath = gateStatePathFor(sessionId);
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    fs.mkdirSync(stateDirFor(sessionId), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(next, null, 2), "utf8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}
