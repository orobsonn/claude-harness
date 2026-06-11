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
 * Atomically OVERWRITES gate-state.json with exactly `{ feature_id: featureId }`,
 * discarding any prior brainstormed/adversary_fired flags. Used on (re)classify so
 * per-feature ceremony never carries stale flags across features in one session.
 * Writes to <path>.<pid>.tmp then fs.renameSync to target (atomic; pid-suffixed temp
 * avoids concurrent-process collision). Never throws. Returns true on success, false otherwise.
 * @param {string} sessionId - The session identifier
 * @param {string} featureId - The feature_id to stamp as the sole field
 * @returns {boolean} true on success, false on any error
 */
export function resetGateState(sessionId, featureId) {
  try {
    const targetPath = gateStatePathFor(sessionId);
    const tmpPath = `${targetPath}.${process.pid}.tmp`;
    fs.mkdirSync(stateDirFor(sessionId), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify({ feature_id: featureId }, null, 2), "utf8");
    fs.renameSync(tmpPath, targetPath);
    return true;
  } catch {
    return false;
  }
}
