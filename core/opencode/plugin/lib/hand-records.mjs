/** @description List OC hand-records under .opencode/plans/.state/hand-records/<feature>/<session>/<task>.json. Never throws. */

import fs from "node:fs";
import path from "node:path";
import { isSafeFeatureId } from "../../../shared/lib/feature-id.mjs";

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
