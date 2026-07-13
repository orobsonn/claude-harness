/**
 * @description Per-run observability outbox persistence lib. Zero-dep (Node builtins only),
 * fail-open (reads return [] / null on error; writes never throw). Split persistence eliminates
 * the two-writer race: session-side hooks APPEND to obs-<issue>.events.jsonl while cron-side
 * cursor/status rewrites touch obs-<issue>.json — DISJOINT files. Meta is written atomically
 * (temp->rename); the events log is append-only. Keyed by issue# under config.stateDir.
 */
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const INITIAL_CURSOR = 0;
const INITIAL_STATUS = "active";
const INITIAL_THREAD_ID = null;
const CLOSED_STATUS = "closed";
const AWAITING_REVIEW_STATUS = "awaiting-review";
/** @description Terminal-ish non-closed statuses that must reactivate on re-dispatch (Telegram silence bug). */
const REACTIVATE_STATUSES = new Set(["orphan", "fallback", AWAITING_REVIEW_STATUS]);
const TEMP_SUFFIX = `.${process.pid}.tmp`;
const FOSSIL_KEYS = ["closedAt", "topicDeletedAt"];
// PIPE_BUF (4096 on Linux) is the largest write guaranteed atomic per-line across concurrent
// writers. Appends beyond it can tear a MIDDLE line under contention — best-effort: we still
// append, accepting the documented fail-open silent-drop on a torn middle line.

/** @description Derives the append-only events log path from a meta path (disjoint file). */
function eventsPathFor(metaPath) {
  return metaPath.replace(/\.json$/, ".events.jsonl");
}

/** @description Reads and parses the meta JSON, or null on any error (fail-open). */
function readMetaRecord(metaPath) {
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

/** @description Atomic temp->rename write of a meta object; returns true on success, false on failure; never throws (fail-open). */
function atomicWriteMeta(metaPath, meta) {
  const tmpPath = `${metaPath}${TEMP_SUFFIX}`;
  try {
    mkdirSync(dirname(metaPath), { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(meta), "utf8");
    renameSync(tmpPath, metaPath);
    return true;
  } catch {
    // fail-open: a failed write must never propagate to the caller (never throw / never delay a cron).
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort temp cleanup; never mask the silent fail-open
    }
    return false;
  }
}

/** @description True when the meta carries any fossil timestamp (closedAt/topicDeletedAt). */
function hasFossilTimestamps(meta) {
  return FOSSIL_KEYS.some((key) => key in meta);
}

/** @description Returns a shallow copy of the meta with the fossil timestamps removed. */
function stripFossilTimestamps(meta) {
  const next = { ...meta };
  for (const key of FOSSIL_KEYS) delete next[key];
  return next;
}

/**
 * @description Creates (or idempotently reuses) the outbox meta for an issue. When a non-closed
 * meta already exists it is reused AS-IS — events and cursor are NEVER reset. When the prior run
 * is closed (or absent) a fresh meta is written atomically. Returns the meta path.
 * @param {{ issueNumber: number, project: string, worktreePath: string }} input
 * @param {string} stateDir — cron-side state directory
 * @returns {string} the obs-<issue>.json path
 */
export function createRun({ issueNumber, project, worktreePath }, stateDir) {
  // Reject non-integer issueNumber before deriving the path: a caller passing '../../x' would
  // otherwise escape stateDir via join (path traversal). Fail-open returns null.
  if (!Number.isInteger(issueNumber)) return null;
  const metaPath = join(stateDir, `obs-${issueNumber}.json`);
  const existing = readMetaRecord(metaPath);
  if (existing && existing.status !== CLOSED_STATUS) {
    // Reactivate terminal-ish statuses (awaiting-review / orphan / fallback): reuse-with-truncate.
    // orphan/fallback used to be "idempotent reuse AS-IS" — that left status stuck, cursor advanced,
    // and no new `picked` event → Telegram silence on re-dispatch after a died run (#291).
    // Preserve threadId/chatId, reset cursor to 0, truncate events log, set status to active,
    // refresh worktreePath, strip fossils. Truncate FIRST so an interleaved drain never re-sends
    // the old log against a reset cursor.
    if (REACTIVATE_STATUSES.has(existing.status)) {
      let truncated = false;
      try {
        writeFileSync(eventsPathFor(metaPath), "", "utf8");
        truncated = true;
      } catch {
        // best-effort: a failed truncate must never propagate to the caller
      }

      if (truncated) {
        atomicWriteMeta(metaPath, stripFossilTimestamps({
          ...existing,
          worktreePath,
          project,
          cursor: INITIAL_CURSOR,
          status: INITIAL_STATUS,
          criticalSent: [],
        }));
      }

      return metaPath;
    }

    // Idempotent reuse for still-active runs: never reset events/cursor/threadId.
    // Only refresh worktreePath + strip fossils when present.
    const freshExisting = readMetaRecord(metaPath);
    if (!freshExisting) return metaPath;
    let dirty = false;
    if (hasFossilTimestamps(freshExisting)) {
      for (const key of FOSSIL_KEYS) delete freshExisting[key];
      dirty = true;
    }
    if (worktreePath && freshExisting.worktreePath !== worktreePath) {
      freshExisting.worktreePath = worktreePath;
      dirty = true;
    }
    if (dirty) atomicWriteMeta(metaPath, freshExisting);
    return metaPath;
  }
  const meta = {
    issueNumber,
    project,
    worktreePath,
    threadId: INITIAL_THREAD_ID,
    cursor: INITIAL_CURSOR,
    status: INITIAL_STATUS,
  };
  atomicWriteMeta(metaPath, meta);
  // Fresh branch (prior run closed or absent): truncate the old events log to match cursor=0 so a
  // re-dispatch after close does not re-emit stale events (duplicate notifications). Fail-open.
  try {
    writeFileSync(eventsPathFor(metaPath), "", "utf8");
  } catch {
    // best-effort: a failed truncate must never propagate to the caller
  }
  return metaPath;
}

/**
 * @description Appends one event as a single JSON line to obs-<issue>.events.jsonl (derived from
 * the meta path). appendFileSync — the session-side writer; never touches the meta file, never throws.
 * @param {string} metaPath
 * @param {object} event
 * @returns {void}
 */
export function appendEvent(metaPath, event) {
  if (typeof metaPath !== "string") return;
  const eventsPath = eventsPathFor(metaPath);
  try {
    mkdirSync(dirname(eventsPath), { recursive: true });
    // Stamp the real append instant onto the event so the Telegram renderer shows WHEN each checkpoint
    // happened, not the batched 3-min drain time (which collapses an hour of work into ~2 timestamps).
    // Stamp only when absent — a producer that set its own `ts` keeps it. A non-object event is written
    // as-is (fail-open, never throw).
    const stamped =
      event && typeof event === "object" && !Array.isArray(event) && event.ts == null
        ? { ...event, ts: new Date().toISOString() }
        : event;
    // Best-effort per-line atomicity: a serialized event > PIPE_BUF (4096) can tear a MIDDLE line
    // under concurrent appends. We still append (fail-open) — the JSONL one-object-per-line contract
    // holds; a torn middle line is silently dropped by readEvents (accepted degradation).
    const line = JSON.stringify(stamped);
    appendFileSync(eventsPath, `${line}\n`, "utf8");
  } catch {
    // fail-open: a failed append must never propagate to the session hook
  }
}

/**
 * @description Reads all complete events from the JSONL. Tolerant of an in-flight append: a
 * truncated/unparseable LAST line (no trailing newline) is skipped silently. NOTE: under a
 * concurrent append larger than PIPE_BUF, a MIDDLE line can also be torn — such a parse failure is
 * silently skipped (the accepted fail-open degradation); the whole file is never dropped to [] when
 * complete events exist. Never throws. Returns [] on a missing/empty log.
 * @param {string} metaPath
 * @returns {object[]}
 */
export function readEvents(metaPath) {
  if (typeof metaPath !== "string") return [];
  const eventsPath = eventsPathFor(metaPath);
  let raw;
  try {
    raw = readFileSync(eventsPath, "utf8");
  } catch {
    return [];
  }
  if (!raw) return [];
  const lines = raw.split("\n");
  const events = [];
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A parse failure is expected on a truncated trailing line (in-flight append, no trailing
      // newline) OR on a MIDDLE line torn by a concurrent >PIPE_BUF append — skip silently. Any
      // other corruption is also skipped: fail-open, never throw.
    }
  }
  return events;
}

/**
 * @description Reads the parsed meta, or null on any error (fail-open).
 * @param {string} metaPath
 * @returns {object|null}
 */
export function readMeta(metaPath) {
  return readMetaRecord(metaPath);
}

/**
 * @description Atomically rewrites the meta with an updated cursor (temp->rename). Never touches
 * the JSONL — the cron-side drain writer. Never throws (fail-open).
 * @param {string} metaPath
 * @param {number} cursor
 * @returns {void}
 */
export function advanceCursor(metaPath, cursor) {
  const meta = readMetaRecord(metaPath);
  if (!meta) return;
  meta.cursor = cursor;
  atomicWriteMeta(metaPath, meta);
}

/**
 * @description Atomic temp->rename PARTIAL merge of the meta JSON — the SOLE writer of threadId and
 * status (fallback/orphan/closed). Only the supplied keys are overwritten; every other field is
 * preserved. Never throws (fail-open).
 * @param {string} metaPath
 * @param {object} partial
 * @returns {void}
 */
export function updateMeta(metaPath, partial) {
  const meta = readMetaRecord(metaPath);
  if (!meta) return;
  Object.assign(meta, partial);
  atomicWriteMeta(metaPath, meta);
}

/**
 * @description Compare-and-swap partial merge: applies `partial` only when the meta currently on disk
 * still matches every key in `expected` (strict compare). Returns true when the write happened, false
 * on any divergence or missing meta. Synchronous read-compare-write with NO await between the re-read
 * and the temp->rename — the residual local-file race is explicitly accepted (a closed run always
 * takes createRun's fresh branch, so a Telegram delete is safe). Never throws (the atomic write is
 * fail-open).
 * @param {string} metaPath
 * @param {object} expected
 * @param {object} partial
 * @returns {boolean}
 */
export function updateMetaIfUnchanged(metaPath, expected, partial) {
  const meta = readMetaRecord(metaPath);
  if (!meta) return false;
  for (const key of Object.keys(expected)) {
    if (!(key in meta) || meta[key] !== expected[key]) return false;
  }
  Object.assign(meta, partial);
  return atomicWriteMeta(metaPath, meta);
}
