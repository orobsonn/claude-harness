/** @description List/write OC hand-records under .opencode/plans/.state/hand-records/<feature>/<session>/<task>.json. Never throws. */

import fs from "node:fs";
import path from "node:path";
import { isSafeFeatureId } from "../../shared/lib/feature-id.mjs";
import { handRecordPath } from "../../shared/lib/path-helpers.mjs";

/** @description Match last Status: line from Task output. Order: DONE_WITH before DONE. */
const HAND_STATUS_RE =
  /Status:\s*(DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED|DONE)\b/g;

/**
 * @description Parse agent status line from Task output text. Returns DONE|DONE_WITH_CONCERNS|NEEDS_CONTEXT|BLOCKED or null.
 * @param {unknown} text
 * @returns {"DONE"|"DONE_WITH_CONCERNS"|"NEEDS_CONTEXT"|"BLOCKED"|null}
 */
export function parseHandStatusFromOutput(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  let last = null;
  HAND_STATUS_RE.lastIndex = 0;
  let m;
  while ((m = HAND_STATUS_RE.exec(text)) !== null) {
    last = m[1];
  }
  return last;
}

/**
 * @description Build Task-path hand-record object (adapter-written, not model prose alone for attestation).
 * @param {{
 *   featureId: string,
 *   taskId: string,
 *   sessionId: string,
 *   freezeCommitSha?: string | null,
 *   outcome: string,
 *   touchedPaths?: string[],
 *   agent?: string,
 *   timestamps?: { startedAt?: string, finishedAt?: string },
 * }} p
 * @returns {object}
 */
export function buildTaskHandRecord({
  featureId,
  taskId,
  sessionId,
  freezeCommitSha = null,
  outcome,
  touchedPaths = [],
  agent,
  timestamps = {},
}) {
  const now = timestamps.finishedAt ?? new Date().toISOString();
  return {
    featureId,
    taskId,
    sessionId,
    freezeCommitSha: freezeCommitSha ?? null,
    outcome,
    touchedPaths: Array.isArray(touchedPaths) ? touchedPaths : [],
    scopeViolations: [],
    frozenViolations: [],
    agent,
    startedAt: timestamps.startedAt ?? now,
    finishedAt: now,
    writtenBy: "obs-hand-task",
  };
}

/**
 * @description Write run-record at session-scoped handRecordPath. Never throws.
 * @param {{
 *   roots: { projectRoot: string, runtime: "opencode", sessionId: string, featureId: string },
 *   taskId: string,
 *   record: object,
 *   mkdir?: (p: string) => void,
 *   writeFile?: (p: string, data: string) => void,
 * }} args
 * @returns {{ ok: true, path: string } | { ok: false, reason: string }}
 */
export function writeHandRecord({
  roots,
  taskId,
  record,
  mkdir = (p) => fs.mkdirSync(p, { recursive: true }),
  writeFile = (p, data) => fs.writeFileSync(p, data, "utf8"),
  rename = (from, to) => fs.renameSync(from, to),
  rm = (p) => fs.rmSync(p, { force: true }),
}) {
  let temporary = "";
  try {
    const resolved = handRecordPath(roots, taskId);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    mkdir(path.dirname(resolved.path));
    temporary = `${resolved.path}.${process.pid}.tmp`;
    writeFile(temporary, JSON.stringify(record, null, 2));
    rename(temporary, resolved.path);
    return { ok: true, path: resolved.path };
  } catch (err) {
    if (temporary) {
      try {
        rm(temporary);
      } catch {
        /* ignore */
      }
    }
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "writeHandRecord failed",
    };
  }
}

/**
 * @description Resolve feature hand-records root under projectRoot only.
 * @param {string} projectRoot
 * @param {string} featureId
 * @returns {string | null}
 */
function featureHandRecordsDir(projectRoot, featureId) {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return null;
  if (!isSafeFeatureId(featureId)) return null;
  const root = path.resolve(projectRoot);
  const dir = path.resolve(root, ".opencode", "plans", ".state", "hand-records", featureId);
  const rel = path.relative(root, dir);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return dir;
}

/**
 * @description Parse a hand-record JSON file; null on any error or non-object.
 * @param {string} filePath
 * @returns {object | null}
 */
function readRecordFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
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
 * @description Walks all session subdirs under hand-records/<featureId> and returns every task record.
 * Path template: .opencode/plans/.state/hand-records/<featureId>/<sessionId>/<taskId>.json
 * Unsafe featureId → []. Missing dir → []. Never throws.
 * @param {string} projectRoot
 * @param {string} featureId
 * @returns {Array<{ taskId: string, sessionId: string, record: object }>}
 */
export function listHandRecordsForFeature(projectRoot, featureId) {
  try {
    const featureDir = featureHandRecordsDir(projectRoot, featureId);
    if (!featureDir) return [];

    let sessionEntries;
    try {
      sessionEntries = fs.readdirSync(featureDir, { withFileTypes: true });
    } catch {
      return [];
    }

    /** @type {Array<{ taskId: string, sessionId: string, record: object }>} */
    const results = [];

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionId = sessionEntry.name;
      const sessionDir = path.join(featureDir, sessionId);

      let taskEntries;
      try {
        taskEntries = fs.readdirSync(sessionDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const taskEntry of taskEntries) {
        if (!taskEntry.isFile()) continue;
        if (!taskEntry.name.endsWith(".json")) continue;
        const taskId = taskEntry.name.slice(0, -".json".length);
        if (!taskId) continue;
        const record = readRecordFile(path.join(sessionDir, taskEntry.name));
        if (record !== null) {
          results.push({ taskId, sessionId, record });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}
