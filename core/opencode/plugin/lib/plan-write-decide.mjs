/**
 * @description Pure decide for OC plan-write-gate: anti-forge + optional scope rail.
 * Denies Write/Edit to gate-state.json, triage.json, and any JSON under
 * .opencode/plans/.state/ — absolute or relative. Does NOT deny execution-plan.json
 * (orchestrator/build may author the plan via Write or bash; bash forge is separate).
 * Accepts CC shape (tool_input.file_path) and OC shape (args.filePath|path|file|target).
 * Anti-forge is fail-closed (outside soft catch). Scope rail fail-opens when context
 * is incomplete or on rail errors; armed active_dispatch denies executor/sniper
 * subagent writes outside scope_paths ∪ allowed_writes (family match). Under an
 * armed hand dispatch, subagent writes with empty/non-hand actingRole are denied
 * (cannot verify identity — no fail-open on agent_id-only).
 */

import path from "node:path";
import { isExecutorRole, isSniperRole, isTestAuthorRole } from "./roles.mjs";

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
  "core/opencode/plugin/marker-authority.ts",
  ".opencode/plugin/marker-authority.ts",
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
  // Every segment: first .opencode may be a decoy parent (e.g. /tmp/.opencode/work/proj/...)
  for (let i = 0; i < segs.length - 2; i++) {
    if (
      segs[i] === ".opencode" &&
      segs[i + 1] === "plans" &&
      segs[i + 2] === ".state"
    ) {
      return true;
    }
  }
  return false;
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
 * @description Normalize path for scope compare: backslash→slash, posix normalize.
 * Case-sensitive (Linux) — do not lower-case; role folding lives in roles.mjs only.
 * @param {unknown} p
 * @returns {string}
 */
export function normalizeScopePath(p) {
  if (typeof p !== "string" || p.length === 0) return "";
  return path.posix.normalize(p.replace(/\\/g, "/"));
}

/**
 * @description True iff file is inside scope entry — exact always; directory prefix only
 * when entry ends with `/` OR has no file extension. File entries are exact-only
 * (src/a.ts does not contain src/a.ts/evil.ts).
 * @param {unknown} filePath
 * @param {unknown} entry
 * @returns {boolean}
 */
export function scopeContains(filePath, entry) {
  if (typeof filePath !== "string" || typeof entry !== "string") return false;
  if (filePath.length === 0 || entry.length === 0) return false;

  const entryRaw = entry.replace(/\\/g, "/");
  const hadTrailingSlash = entryRaw.endsWith("/");
  const normFile = normalizeScopePath(filePath);
  const normEntry = normalizeScopePath(entry);
  if (normFile.length === 0 || normEntry.length === 0) return false;

  // Exact match always (after normalize — catches .. that collapses to the entry).
  if (normFile === normEntry) return true;

  // Directory prefix only when trailing slash OR no extension.
  const isDir =
    hadTrailingSlash ||
    normEntry.endsWith("/") ||
    path.extname(normEntry) === "";
  if (!isDir) return false;

  const prefix = normEntry.endsWith("/") ? normEntry : `${normEntry}/`;
  return normFile.startsWith(prefix);
}

/**
 * @description Same hand family (executor* or sniper*) — not exact string equality.
 * @param {unknown} actingRole
 * @param {unknown} dispatchRole
 * @returns {boolean}
 */
function sameHandFamily(actingRole, dispatchRole) {
  if (isExecutorRole(actingRole) && isExecutorRole(dispatchRole)) return true;
  if (isSniperRole(actingRole) && isSniperRole(dispatchRole)) return true;
  if (isTestAuthorRole(actingRole) && isTestAuthorRole(dispatchRole)) return true;
  return false;
}

/**
 * @description Scope rail: deny out-of-scope executor/sniper subagent writes when
 * active_dispatch is armed. Returns null when rail is off / allow; Decision when deny.
 * Fail-open (null) on incomplete context. Under armed hand dispatch, empty/non-hand
 * actingRole on a subagent is DENY (identity unverifiable). Never throws to caller.
 * @param {string} filePath
 * @param {{
 *   gateState?: unknown,
 *   actingRole?: unknown,
 *   isSubagent?: unknown,
 * }} opts
 * @returns {Decision | null}
 */
function decideScopeRail(filePath, opts) {
  if (opts.isSubagent !== true) return null;

  const gateState = opts.gateState;
  if (gateState == null || typeof gateState !== "object" || Array.isArray(gateState)) {
    return null;
  }
  const ad = /** @type {Record<string, unknown>} */ (gateState).active_dispatch;
  if (ad == null || typeof ad !== "object" || Array.isArray(ad)) return null;

  const adObj = /** @type {Record<string, unknown>} */ (ad);
  // Rail only arms for hand-family dispatches with non-empty scope.
  if (!isExecutorRole(adObj.role) && !isSniperRole(adObj.role) && !isTestAuthorRole(adObj.role)) return null;

  const scopePathsRaw = adObj.scope_paths;
  if (!Array.isArray(scopePathsRaw) || scopePathsRaw.length === 0) return null;
  const scopePaths = scopePathsRaw.filter((s) => typeof s === "string" && s.length > 0);
  if (scopePaths.length === 0) return null;

  const actingRole = opts.actingRole;
  const actingIsHand =
    isExecutorRole(actingRole) || isSniperRole(actingRole) || isTestAuthorRole(actingRole);

  // Armed hand rail + subagent without verifiable hand identity → DENY (no fail-open).
  if (!actingIsHand) {
    const featureId =
      typeof adObj.feature_id === "string" ? adObj.feature_id : "?";
    const taskId = typeof adObj.task_id === "string" ? adObj.task_id : "?";
    return {
      allow: false,
      reason:
        `${PREFIX} Blocked: subagent write to '${filePath}' under armed hand dispatch ` +
        `(${featureId}/${taskId}) cannot verify acting role identity. ` +
        `Refusing fail-open when only agent_id (or non-hand role) is present.`,
    };
  }

  // Family mismatch still fail-open (different hand family is not this rail's subject).
  if (!sameHandFamily(actingRole, adObj.role)) return null;

  const allowedWritesRaw = adObj.allowed_writes;
  const allowedWrites = Array.isArray(allowedWritesRaw)
    ? allowedWritesRaw.filter((s) => typeof s === "string" && s.length > 0)
    : [];

  const inScope = scopePaths.some((s) => scopeContains(filePath, s));
  const inAllowed = allowedWrites.some((s) => scopeContains(filePath, s));
  if (inScope || inAllowed) return null;

  const roleLabel = isSniperRole(actingRole) ? "sniper" : isTestAuthorRole(actingRole) ? "test-author" : "executor";
  const featureId =
    typeof adObj.feature_id === "string" ? adObj.feature_id : "?";
  const taskId = typeof adObj.task_id === "string" ? adObj.task_id : "?";
  const scopeList = scopePaths.join(", ");
  const allowedSuffix =
    allowedWrites.length > 0
      ? ` (plus allowed writes: ${allowedWrites.join(", ")})`
      : "";

  return {
    allow: false,
    reason:
      `${PREFIX} Blocked: ${roleLabel} hand write to '${filePath}' is OUTSIDE its dispatch scope. ` +
      `The active dispatch (${featureId}/${taskId}) is scoped to: ${scopeList}` +
      `${allowedSuffix}. Stay inside scope_paths, or fold this path into the plan's scope deliberately before writing it.`,
  };
}

/**
 * @typedef {{ allow: boolean, reason?: string }} Decision
 */

/**
 * @description Anti-forge first (fail-closed), then optional scope rail (fail-open).
 * @param {unknown} payload
 * @param {{
 *   gateState?: unknown,
 *   actingRole?: unknown,
 *   isSubagent?: unknown,
 * }} [opts]
 * @returns {Decision}
 */
export function decide(payload, opts = {}) {
  // --- Anti-forge: fail-closed, outside soft catch ---
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

  // --- Scope rail: fail-open on incomplete context or rail errors ---
  try {
    // Prefer opts.gateState; allow payload.gateState as secondary injection surface.
    const p = /** @type {Record<string, unknown>} */ (payload);
    const gateState =
      opts.gateState !== undefined ? opts.gateState : p.gateState;
    const scopeDeny = decideScopeRail(filePath, {
      gateState,
      actingRole: opts.actingRole,
      isSubagent: opts.isSubagent,
    });
    if (scopeDeny) return scopeDeny;
  } catch {
    // scope_rail_errors_fail_open
    return { allow: true };
  }

  // execution-plan.json is allowed (LIGHT model C — orchestrator may author plan)
  return { allow: true };
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
