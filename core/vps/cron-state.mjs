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
const CHAIN_FILE_NAME = "cron-chain.json";
const BREAKER_FILE_NAME = "cron-breaker.json";
const UPDATE_ATTEMPTS_FILE_NAME = "cron-update-attempts.json";
const INFRA_FAILURE_FILE_NAME = "cron-review-infra-failures.json";

const CHAIN_CEILING = 3;
const INFRA_FAILURE_CEILING = 3;
const BREAKER_WINDOW_SECONDS = 21_600;
const BREAKER_MAX_SESSIONS = 12;

function countersFilePath(stateDir) {
  return join(stateDir, COUNTERS_FILE_NAME);
}

function reviewedFilePath(stateDir) {
  return join(stateDir, REVIEWED_FILE_NAME);
}

function chainFilePath(stateDir) {
  return join(stateDir, CHAIN_FILE_NAME);
}

function breakerFilePath(stateDir) {
  return join(stateDir, BREAKER_FILE_NAME);
}

function updateAttemptsFilePath(stateDir) {
  return join(stateDir, UPDATE_ATTEMPTS_FILE_NAME);
}

function infraFailureFilePath(stateDir) {
  return join(stateDir, INFRA_FAILURE_FILE_NAME);
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

// --- PR-keyed update-branch attempt store (cron-update-attempts.json) ---
// Keyed by PR number. Incremented once per successful `gh pr update-branch` on a merge that
// failed because the branch was only BEHIND its base. A dedicated store (not the fix-attempt
// cron-counters.json nor the reject-chain cron-chain.json) because "how many times did we
// auto-refresh this stale branch" is an independent dimension from fix attempts and reject depth.

/**
 * @description Increments the update-branch attempt counter for the given PR by 1.
 * @param {number} pr
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function incrementUpdateAttempt(pr, opts) {
  const filePath = updateAttemptsFilePath(opts.stateDir);
  const attempts = readJsonRecord(filePath);
  attempts[pr] = (attempts[pr] ?? 0) + 1;
  writeJsonRecord(filePath, attempts);
}

/**
 * @description Reads the current update-branch attempt count for the given PR (0 if never bumped).
 * @param {number} pr
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {number}
 */
export function readUpdateAttempts(pr, opts) {
  const attempts = readJsonRecord(updateAttemptsFilePath(opts.stateDir));
  return attempts[pr] ?? 0;
}

/**
 * @description Resets the update-branch attempt count for the given PR back to 0 (called on merge).
 * @param {number} pr
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function resetUpdateAttempts(pr, opts) {
  const filePath = updateAttemptsFilePath(opts.stateDir);
  const attempts = readJsonRecord(filePath);
  attempts[pr] = 0;
  writeJsonRecord(filePath, attempts);
}

// --- Root-keyed chain-depth store (cron-chain.json) ---
// Keyed by the issue number (root). Incremented once per review-REJECT.
// Separate from cron-counters.json — chain depth and attempt count are independent dimensions.

/**
 * @description Increments the chain depth for the given root issue by 1.
 * @param {number} root
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function incrementChain(root, opts) {
  const filePath = chainFilePath(opts.stateDir);
  const chain = readJsonRecord(filePath);
  chain[root] = (chain[root] ?? 0) + 1;
  writeJsonRecord(filePath, chain);
}

/**
 * @description Reads the current chain depth for the given root issue (0 if never incremented).
 * @param {number} root
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {number}
 */
export function readChain(root, opts) {
  const chain = readJsonRecord(chainFilePath(opts.stateDir));
  return chain[root] ?? 0;
}

/**
 * @description Resets the chain depth for the given root issue back to 0.
 * @param {number} root
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function resetChain(root, opts) {
  const filePath = chainFilePath(opts.stateDir);
  const chain = readJsonRecord(filePath);
  chain[root] = 0;
  writeJsonRecord(filePath, chain);
}

/**
 * @description Returns true when the chain depth for the given root has exceeded the ceiling (3).
 * @param {number} root
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {boolean}
 */
export function atCeiling(root, opts) {
  return readChain(root, opts) > CHAIN_CEILING;
}

// --- Time-windowed circuit-breaker store (cron-breaker.json) ---
// Holds { window_start_ts, count }. Rolls over (count resets) when now - window_start
// exceeds the window. Trips when count reaches the per-window limit.
// The cap is driven by real per-session increments — recordReviewSession() is the only
// path that bumps the count; the trip/rollover/reset decision alone never bumps it.

/**
 * @description Reads the raw breaker record from disk.
 * @param {string} stateDir
 * @returns {{ window_start_ts: number, count: number }}
 */
function readBreakerRecord(stateDir) {
  const record = readJsonRecord(breakerFilePath(stateDir));
  return { window_start_ts: record.window_start_ts ?? 0, count: record.count ?? 0 };
}

/**
 * @description Writes the breaker record to disk atomically.
 * @param {string} stateDir
 * @param {{ window_start_ts: number, count: number }} record
 * @returns {void}
 */
function writeBreakerRecord(stateDir, record) {
  writeJsonRecord(breakerFilePath(stateDir), record);
}

/**
 * @description Records a review session, bumping the per-window count by 1.
 * Creates or rolls the window as needed — this is the ONLY path that increments
 * the breaker count. The trip/rollover/reset decision alone never bumps it.
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {number} [opts.now] — current timestamp in seconds; defaults to Date.now()/1000
 * @returns {void}
 */
export function recordReviewSession(opts) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const record = readBreakerRecord(opts.stateDir);

  // Roll over if the window has elapsed
  if (now - record.window_start_ts >= BREAKER_WINDOW_SECONDS) {
    record.window_start_ts = now;
    record.count = 0;
  }

  record.count += 1;
  writeBreakerRecord(opts.stateDir, record);
}

/**
 * @description Returns true when the breaker is tripped (count >= limit within the current window).
 * Does NOT bump the count — the cap is driven by real recordReviewSession() calls.
 * @param {object} opts
 * @param {string} opts.stateDir
 * @param {number} [opts.now] — current timestamp in seconds; defaults to Date.now()/1000
 * @returns {boolean}
 */
export function breakerTripped(opts) {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const record = readBreakerRecord(opts.stateDir);

  // If the window has elapsed, the breaker is not tripped (count is effectively 0)
  if (now - record.window_start_ts >= BREAKER_WINDOW_SECONDS) {
    return false;
  }

  return record.count >= BREAKER_MAX_SESSIONS;
}

// --- pr:sha-keyed review infra-failure store (cron-review-infra-failures.json) ---
// Keyed by `${pr}:${sha}`. Incremented once per review cycle in which the review session produced
// NO verdict artifact (it crashed / timed out) — an INFRA failure, DISTINCT from a real BLOCKED
// review reject (which lives in cron-chain.json). A dedicated file so the operator never conflates
// "the review session kept dying" with "the code was rejected". Keyed by pr:sha on purpose: a new
// push (sha change) yields a new key and the counter zeroes naturally — no explicit reset needed.

/**
 * @description Increments the infra-failure count for the given PR at the given head SHA by 1.
 * @param {number} pr
 * @param {string} sha
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {void}
 */
export function incrementInfraFailure(pr, sha, opts) {
  const filePath = infraFailureFilePath(opts.stateDir);
  const failures = readJsonRecord(filePath);
  const key = `${pr}:${sha}`;
  failures[key] = (failures[key] ?? 0) + 1;
  writeJsonRecord(filePath, failures);
}

/**
 * @description Reads the current infra-failure count for the given PR at the given head SHA (0 if
 * never incremented).
 * @param {number} pr
 * @param {string} sha
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {number}
 */
export function readInfraFailure(pr, sha, opts) {
  const failures = readJsonRecord(infraFailureFilePath(opts.stateDir));
  return failures[`${pr}:${sha}`] ?? 0;
}

/**
 * @description Returns true when the infra-failure count for the given PR at the given head SHA has
 * REACHED the ceiling (>= 3) — the review session has crashed/timed out enough times that the issue
 * should be blocked for the operator instead of retried forever.
 * @param {number} pr
 * @param {string} sha
 * @param {object} opts
 * @param {string} opts.stateDir
 * @returns {boolean}
 */
export function atInfraFailureCeiling(pr, sha, opts) {
  return readInfraFailure(pr, sha, opts) >= INFRA_FAILURE_CEILING;
}
