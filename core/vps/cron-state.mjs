/**
 * @description Per-issue attempt counter and reviewed-SHA marker used by the VPS cron
 * harness. State is persisted as two small JSON files under opts.stateDir: one mapping
 * issue number -> attempt count, the other mapping "pr:sha" -> reviewed flag.
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";

const COUNTERS_FILE_NAME = "cron-counters.json";
const REVIEWED_FILE_NAME = "cron-reviewed.json";

function countersFilePath(stateDir) {
  return join(stateDir, COUNTERS_FILE_NAME);
}

function reviewedFilePath(stateDir) {
  return join(stateDir, REVIEWED_FILE_NAME);
}

function readJsonRecord(filePath) {
  let raw;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    // ENOENT: legitimate first run, no state written yet.
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Non-empty but unparsable: a genuine crash/corruption (e.g. mid-write before the atomic
    // write below existed, or external tampering) — NOT the same as a fresh file. Silently
    // returning {} here would let the next write wipe every OTHER issue's counter (a chronically
    // failing issue would then never reach its ceiling and get re-queued forever). Preserve the
    // corrupt bytes for forensics instead of discarding them, and surface it, before falling back
    // to an empty record — recovering the prior counts is out of scope, but the loss is never
    // silent.
    if (raw.length > 0) {
      try {
        // Unique suffix (pid+rand) so two same-millisecond corruptions never overwrite each
        // other's forensic copy.
        const forensicPath = `${filePath}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
        writeFileSync(forensicPath, raw, "utf8");
      } catch {
        // best-effort forensics only; must never block the caller's fallback
      }
      console.error(
        `cron-state: ${filePath} was corrupt and has been preserved alongside it; starting from an empty record`
      );
    }
    return {};
  }
}

function writeJsonRecord(filePath, record) {
  // Idempotent self-heal: a missing stateDir (first run, or after external cleanup) must not
  // crash the cron with ENOENT.
  mkdirSync(dirname(filePath), { recursive: true });
  // Atomic write: truncate-then-write can leave a half-written state file behind a crash,
  // which readJsonRecord would otherwise have to treat as corrupt. Write to a private tmp file,
  // then rename — atomic on the same filesystem.
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, JSON.stringify(record), "utf8");
    renameSync(tmpPath, filePath);
  } catch (err) {
    // A failed write/rename must not leak the private temp file behind — remove it best-effort,
    // then re-throw so the caller still sees the failure.
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort temp cleanup; never mask the original failure
    }
    throw err;
  }
}

/**
 * @description Increments the attempt counter for the given issue.
 * @param {number} issue
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function increment(issue, opts) {
  const filePath = countersFilePath(opts.stateDir);
  const counters = readJsonRecord(filePath);
  counters[issue] = (counters[issue] ?? 0) + 1;
  writeJsonRecord(filePath, counters);
}

/**
 * @description Resets the attempt counter for the given issue back to 0.
 * @param {number} issue
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function reset(issue, opts) {
  const filePath = countersFilePath(opts.stateDir);
  const counters = readJsonRecord(filePath);
  counters[issue] = 0;
  writeJsonRecord(filePath, counters);
}

/**
 * @description Reads the current attempt counter for the given issue (0 if never incremented).
 * @param {number} issue
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {number}
 */
export function read(issue, opts) {
  const counters = readJsonRecord(countersFilePath(opts.stateDir));
  return counters[issue] ?? 0;
}

/**
 * @description Records that the given PR has been reviewed at the given head SHA.
 * @param {number} pr
 * @param {string} sha
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function recordReviewed(pr, sha, opts) {
  const filePath = reviewedFilePath(opts.stateDir);
  const reviewed = readJsonRecord(filePath);
  reviewed[`${pr}:${sha}`] = true;
  writeJsonRecord(filePath, reviewed);
}

/**
 * @description Returns whether the given PR has already been reviewed at the given head SHA.
 * @param {number} pr
 * @param {string} sha
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {boolean}
 */
export function alreadyReviewed(pr, sha, opts) {
  const reviewed = readJsonRecord(reviewedFilePath(opts.stateDir));
  return Boolean(reviewed[`${pr}:${sha}`]);
}

// --- Scaffold stubs (freeze baseline) — root-keyed chain store + windowed circuit-breaker.
// Replaced by the executor with the real implementation; throwing keeps the frozen test RED
// while letting it COLLECT (the module still links).
export function incrementChain(root, opts) {
  throw new Error("not implemented");
}
export function readChain(root, opts) {
  throw new Error("not implemented");
}
export function resetChain(root, opts) {
  throw new Error("not implemented");
}
export function atCeiling(root, opts) {
  throw new Error("not implemented");
}
export function recordReviewSession(opts) {
  throw new Error("not implemented");
}
export function breakerTripped(opts) {
  throw new Error("not implemented");
}
