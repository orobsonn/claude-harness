/** @description List/write OC hand-records under .opencode/plans/.state/hand-records/<feature>/<session>/<task>.json. Never throws. */

import fs from "node:fs";
import path from "node:path";
import { isSafeFeatureId } from "../shared/lib/feature-id.mjs";
import { handRecordPath } from "../shared/lib/path-helpers.mjs";
import { isCaptureEligibleHandRecord } from "../shared/lib/real-file-capture-rail.mjs";

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

/** @description Detect a provider capacity stop only when the hand did not provide its own verdict. */
export function isCapacityExhaustedOutput(text) {
  if (typeof text !== "string") return false;
  HAND_STATUS_RE.lastIndex = 0;
  const hasExplicitStatus = HAND_STATUS_RE.test(text);
  HAND_STATUS_RE.lastIndex = 0;
  return !hasExplicitStatus && /\bmaximum steps reached\b/i.test(text);
}

const OC_HAND_RECORD_WRITERS = new Set(["host-hand-finished", "run-hand-adapter"]);

/**
 * @description Validate the factual identity of one OC capture-eligible record against its exact path owner.
 * @param {unknown} record
 * @param {{ featureId: string, taskId: string, sessionId: string, producerCallId?: string, sha?: string }} expected
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateOcCaptureEligibleHandRecord(record, expected) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, reason: "hand-record must be an object" };
  }
  const value = /** @type {Record<string, unknown>} */ (record);
  if (!isCaptureEligibleHandRecord(value)) return { ok: false, reason: "hand-record is not capture-eligible" };
  if (!OC_HAND_RECORD_WRITERS.has(value.writtenBy)) {
    return { ok: false, reason: "hand-record writtenBy is not a host adapter" };
  }
  if (
    value.featureId !== expected.featureId ||
    value.taskId !== expected.taskId ||
    value.sessionId !== expected.sessionId
  ) {
    return { ok: false, reason: "hand-record feature/task/session identity mismatch" };
  }
  if (typeof value.producerCallId !== "string" || value.producerCallId.length === 0) {
    return { ok: false, reason: "hand-record producer call identity missing" };
  }
  if (typeof expected.producerCallId === "string" && value.producerCallId !== expected.producerCallId) {
    return { ok: false, reason: "hand-record producer call identity mismatch" };
  }
  if (typeof value.freezeCommitSha !== "string" || value.freezeCommitSha.length === 0) {
    return { ok: false, reason: "hand-record freeze SHA missing" };
  }
  if (typeof expected.sha === "string" && value.freezeCommitSha !== expected.sha) {
    return { ok: false, reason: "hand-record freeze SHA mismatch" };
  }
  return { ok: true };
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
 * @returns {Array<{ taskId: string, sessionId: string, record: object, identityError?: string }>}
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

    /** @type {Array<{ taskId: string, sessionId: string, record: object, identityError?: string }>} */
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
          const identity = isCaptureEligibleHandRecord(record)
            ? validateOcCaptureEligibleHandRecord(record, { featureId, taskId, sessionId })
            : { ok: true };
          results.push({
            taskId,
            sessionId,
            record,
            ...(!identity.ok ? { identityError: identity.reason } : {}),
          });
        }
      }
    }

    return results;
  } catch {
    return [];
  }
}
