/**
 * @description Pure decide for OC plan-write-gate (LIGHT: state anti-forge only).
 * Denies Write/Edit to gate-state.json, triage.json, and any JSON under
 * .opencode/plans/.state/ — absolute or relative. Does NOT deny execution-plan.json
 * (orchestrator/build may author the plan via Write or bash; bash forge is separate).
 * Accepts CC shape (tool_input.file_path) and OC shape (args.filePath|path|file|target).
 * Fail-open only on non-oracle infra shape errors.
 */

import path from "node:path";

const FORBIDDEN_STATE_BASENAMES = new Set(["gate-state.json", "triage.json"]);
/** Marker / forge-allowlist scripts — never Write-overwrite (impostor under trusted path). */
const FORBIDDEN_MARKER_BASENAMES = new Set([
  "mark-gate.mjs",
  "mark.mjs",
  "classify.mjs",
]);
/** Tooling scripts on bash allowlist — freeze against Write overwrite. */
const FROZEN_TOOLING_RELATIVE = new Set([
  "scripts/probe-oc-gates-headless.mjs",
  "core/claude-code/skills/initializing-projects/references/vendor-core.mjs",
  "core/claude-code/hooks/mark.mjs",
  "core/claude-code/hooks/classify.mjs",
]);
const PREFIX = "[plan-write-gate]";

/**
 * @param {unknown} filePath
 * @returns {string[]}
 */
function pathSegments(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return [];
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  return norm
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
}

/**
 * @description Fixture carve only — never mid-path ".test." (session ids may contain dots).
 * Real oracle basenames (gate-state.json / triage.json) are never carved.
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isCarvedOut(filePath) {
  if (typeof filePath !== "string") return false;
  const norm = path.posix.normalize(filePath.replace(/\\/g, "/"));
  if (norm.includes("..")) return false;
  const segs = norm
    .split("/")
    .filter((s) => s.length > 0)
    .map((s) => s.toLowerCase());
  if (segs.length === 0) return false;
  const base = segs[segs.length - 1];
  // Live oracle filenames are never fixtures, even under a .test. session segment.
  if (FORBIDDEN_STATE_BASENAMES.has(base)) return false;
  if (segs.includes("__fixtures__")) return true;
  // Basename-only test fixtures e.g. gate-state.test.json
  if (base.includes(".test.")) return true;
  return false;
}

/**
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isForbiddenStateBasename(filePath) {
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  return FORBIDDEN_STATE_BASENAMES.has(segs[segs.length - 1]);
}

/**
 * @description Oracle for plans/.state/** JSON — relative or absolute.
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isStateFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  if (!segs[segs.length - 1].endsWith(".json")) return false;
  const ci = segs.indexOf(".opencode");
  return ci !== -1 && segs[ci + 1] === "plans" && segs[ci + 2] === ".state";
}

/**
 * @description Write to harness marker scripts (path-bound forge allowlist targets).
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isMarkerScriptPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  const segs = pathSegments(filePath);
  if (segs.length === 0) return false;
  const base = segs[segs.length - 1];
  if (!FORBIDDEN_MARKER_BASENAMES.has(base)) return false;
  // plugin/lib/mark-gate.mjs or hooks/mark-gate.mjs (any parent tree)
  const libIdx = segs.lastIndexOf("lib");
  if (libIdx >= 1 && segs[libIdx - 1] === "plugin") return true;
  if (segs.includes("hooks")) return true;
  return false;
}

/**
 * @description Frozen tooling allowlist paths (exact relative).
 * @param {unknown} filePath
 * @returns {boolean}
 */
function isFrozenToolingPath(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) return false;
  let norm = filePath.replace(/\\/g, "/").trim();
  while (norm.startsWith("./")) norm = norm.slice(2);
  // absolute → take suffix match against known relative
  for (const rel of FROZEN_TOOLING_RELATIVE) {
    if (norm === rel || norm.endsWith(`/${rel}`)) return true;
  }
  return false;
}

/**
 * @description Extract file path from CC or OC payload shapes.
 * @param {unknown} payload
 * @returns {string}
 */
export function extractWritePath(payload) {
  if (payload == null || typeof payload !== "object" || Array.isArray(payload)) {
    return "";
  }
  const p = /** @type {Record<string, unknown>} */ (payload);
  const fromToolInput =
    p.tool_input != null &&
    typeof p.tool_input === "object" &&
    !Array.isArray(p.tool_input)
      ? /** @type {Record<string, unknown>} */ (p.tool_input)
      : null;
  const fromArgs =
    p.args != null && typeof p.args === "object" && !Array.isArray(p.args)
      ? /** @type {Record<string, unknown>} */ (p.args)
      : null;
  const candidates = [
    fromToolInput?.file_path,
    fromToolInput?.filePath,
    fromToolInput?.path,
    fromArgs?.filePath,
    fromArgs?.file_path,
    fromArgs?.path,
    fromArgs?.file,
    fromArgs?.target,
    p.filePath,
    p.file_path,
    p.path,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return "";
}

/**
 * @typedef {{ allow: boolean, reason?: string }} Decision
 */

/**
 * @param {unknown} payload
 * @returns {Decision}
 */
export function decide(payload) {
  try {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      return { allow: true };
    }
    const filePath = extractWritePath(payload);
    // Fail-closed: write/edit with unparseable path must not silently forge.
    if (!filePath) {
      return {
        allow: false,
        reason: `${PREFIX} Blocked: write/edit path missing — cannot validate anti-forge oracle.`,
      };
    }
    const carved = isCarvedOut(filePath);
    if (!carved && isForbiddenStateBasename(filePath)) {
      return {
        allow: false,
        reason: `${PREFIX} Blocked: gate-state/triage written ONLY by harness markers, never Write/Edit.`,
      };
    }
    if (!carved && isStateFilePath(filePath)) {
      return {
        allow: false,
        reason: `${PREFIX} Blocked: .opencode/plans/.state/ JSONs written ONLY by harness markers.`,
      };
    }
    if (!carved && isMarkerScriptPath(filePath)) {
      return {
        allow: false,
        reason: `${PREFIX} Blocked: harness marker scripts (mark-gate/mark/classify) are read-only via Write/Edit.`,
      };
    }
    if (!carved && isFrozenToolingPath(filePath)) {
      return {
        allow: false,
        reason: `${PREFIX} Blocked: allowlisted tooling scripts are read-only via Write/Edit (anti-forgery).`,
      };
    }
    // execution-plan.json is allowed (LIGHT model C — orchestrator may author plan)
    return { allow: true };
  } catch {
    return { allow: true };
  }
}

/**
 * @description Map Decision to throw for OC plugin (fail-closed).
 * @param {Decision} decision
 * @returns {void}
 */
export function throwIfDenied(decision) {
  if (decision && decision.allow === false) {
    throw new Error(decision.reason || `${PREFIX} denied`);
  }
}
