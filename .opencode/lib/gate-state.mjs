/** @description Disk gate-state with ownership-token RMW lock. OC shell only (fs). Shared pure patch lives in gate-state-shape. */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { mergeGateStatePatch } from "../shared/lib/gate-state-shape.mjs";

/** Session id safe for path segment (no traversal). Aligned with OC session ids (ses_…). */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/**
 * @description True when session id is safe as a single path segment.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeSessionIdSegment(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    return false;
  }
  // Reject path traversal and separators before regex.
  if (value.includes("..") || value.includes("/") || value.includes("\\")) {
    return false;
  }
  return SAFE_SESSION_ID.test(value);
}

/**
 * @description Load gate-state.json from disk under `.opencode/plans/.state/`.
 * Requires explicit safe sessionId; explicit fail when missing (no cross-session mtime).
 * Fail-closed Result when unreadable. Never throws.
 * @param {string} projectRoot
 * @param {{ sessionId?: string | null }} [opts]
 * @returns {{ ok: true, state: unknown, path: string } | { ok: false, reason: string }}
 */
export function loadGateStateFromDisk(projectRoot, opts = {}) {
  try {
    const root =
      typeof projectRoot === "string" && projectRoot.length > 0
        ? projectRoot
        : process.cwd();
    if (typeof root !== "string" || root.length === 0) {
      return { ok: false, reason: "projectRoot missing" };
    }
    const stateRoot = path.join(root, ".opencode", "plans", ".state");
    const sessionId = opts.sessionId;

    /** @param {string} p */
    function readStateFile(p) {
      try {
        if (!fs.existsSync(p)) {
          // Missing file = empty ceremony (not yet classified), not infra failure.
          // Fail-closed on dual/plan still applies via empty dual_status / missing plan.
          return { ok: true, state: {}, path: p };
        }
        const raw = fs.readFileSync(p, "utf8");
        const state = JSON.parse(raw);
        if (state == null || typeof state !== "object" || Array.isArray(state)) {
          return {
            ok: false,
            reason: `gate-state invalid JSON object at ${p}`,
          };
        }
        return { ok: true, state, path: p };
      } catch (err) {
        return {
          ok: false,
          reason:
            err instanceof Error
              ? `gate-state-unreadable: ${err.message}`
              : "gate-state-unreadable",
        };
      }
    }

    if (sessionId != null && sessionId !== "") {
      if (!isSafeSessionIdSegment(sessionId)) {
        return { ok: false, reason: "unsafe sessionId" };
      }
      const p = path.join(
        stateRoot,
        /** @type {string} */ (sessionId),
        "gate-state.json",
      );
      return readStateFile(p);
    }
    return { ok: false, reason: "sessionId required for deterministic gate-state load" };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : "loadGateStateFromDisk failed",
    };
  }
}

/** @type {number} stale lock age (resolved_judgments.lock_stale_seconds) */
export const LOCK_STALE_MS = 30_000;

/** @type {number} acquire timeout (resolved_judgments.lock_timeout_ms) */
export const LOCK_TIMEOUT_MS = 5_000;

/**
 * @param {string} statePath
 * @returns {string}
 */
export function lockPathFor(statePath) {
  return `${statePath}.lock`;
}

/**
 * @description Best-effort pid liveness (signal 0). Returns false on any error.
 * @param {unknown} pid
 * @returns {boolean}
 */
export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * @description Read lock file JSON or null.
 * @param {string} lockPath
 * @returns {{ token: string, pid: number, createdAt: string } | null}
 */
export function readLockFile(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.token !== "string" ||
      typeof parsed.pid !== "number" ||
      typeof parsed.createdAt !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * @description Compare-and-delete lock only if token still matches.
 * Atomic via rename-to-tombstone: claim the lock inode with rename, verify token
 * on the tombstone, then unlink — never unlink by path after a non-atomic read.
 * On token mismatch, restore with link (EEXIST-safe) so a concurrent acquirer is not clobbered.
 * @param {string} lockPath
 * @param {string} token
 * @returns {boolean}
 */
export function compareAndDeleteLock(lockPath, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  const tombstone = `${lockPath}.${token}.del`;
  try {
    fs.renameSync(lockPath, tombstone);
  } catch {
    return false;
  }
  try {
    const current = readLockFile(tombstone);
    if (!current || current.token !== token) {
      // Not our lock — put it back only if nobody else re-acquired (link fails with EEXIST).
      try {
        fs.linkSync(tombstone, lockPath);
      } catch {
        /* lockPath already taken or restore failed */
      }
      try {
        fs.unlinkSync(tombstone);
      } catch {
        /* ignore */
      }
      return false;
    }
    fs.unlinkSync(tombstone);
    return true;
  } catch {
    try {
      fs.linkSync(tombstone, lockPath);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(tombstone);
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * @description Try exclusive create of lock file (O_EXCL / wx).
 * @param {string} lockPath
 * @param {{ token: string, pid: number, createdAt: string }} body
 * @returns {boolean}
 */
function tryCreateLock(lockPath, body) {
  try {
    fs.writeFileSync(lockPath, JSON.stringify(body), { flag: "wx" });
    return true;
  } catch (err) {
    if (err && /** @type {NodeJS.ErrnoException} */ (err).code === "EEXIST") {
      return false;
    }
    return false;
  }
}

/**
 * @description Acquire ownership-token lock. Stale recovery: age > LOCK_STALE_MS AND pid dead,
 * then compare-and-delete by token before retry.
 * @param {string} statePath
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => number, sleepMs?: (ms: number) => void }} [opts]
 * @returns {{ ok: true, token: string } | { ok: false, decision: "deny", reason: string }}
 */
export function acquireLock(statePath, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  const nowFn = opts.now ?? Date.now;
  const sleep =
    opts.sleepMs ??
    ((ms) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* busy wait for sync tests; production uses short backoff */
      }
    });

  const lockPath = lockPathFor(statePath);
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
  } catch {
    return { ok: false, decision: "deny", reason: "gate-state-lock-mkdir-failed" };
  }

  const deadline = nowFn() + timeoutMs;
  const token = crypto.randomUUID();
  const pid = process.pid;

  while (nowFn() < deadline) {
    const createdAt = new Date(nowFn()).toISOString();
    if (tryCreateLock(lockPath, { token, pid, createdAt })) {
      return { ok: true, token };
    }

    // EEXIST — inspect for stale
    const existing = readLockFile(lockPath);
    if (existing) {
      const createdMs = Date.parse(existing.createdAt);
      const age = Number.isFinite(createdMs) ? nowFn() - createdMs : 0;
      const dead = !isPidAlive(existing.pid);
      if (age > staleMs && dead) {
        compareAndDeleteLock(lockPath, existing.token);
        // retry immediately after break
        continue;
      }
    } else {
      // corrupt/unreadable lock — if very old mtime, exclusive rename claim then unlink only the winner
      try {
        const st = fs.statSync(lockPath);
        if (nowFn() - st.mtimeMs > staleMs) {
          const tombstone = `${lockPath}.${token}.del`;
          try {
            fs.renameSync(lockPath, tombstone);
            // Winner owns the inode — destroy only what we claimed (never unlink by live path)
            try {
              fs.unlinkSync(tombstone);
            } catch {
              /* ignore */
            }
          } catch {
            /* lost rename race — another acquirer claimed it */
          }
          continue;
        }
      } catch {
        /* ignore */
      }
    }

    sleep(20);
  }

  return { ok: false, decision: "deny", reason: "gate-state-lock-timeout" };
}

/**
 * @description Release lock only if file token still equals our token.
 * @param {string} statePath
 * @param {string} token
 * @returns {{ ok: boolean, reason?: string }}
 */
export function releaseLock(statePath, token) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "missing token" };
  }
  const lockPath = lockPathFor(statePath);
  const current = readLockFile(lockPath);
  if (!current) {
    return { ok: false, reason: "no lock" };
  }
  if (current.token !== token) {
    return { ok: false, reason: "token-mismatch" };
  }
  const deleted = compareAndDeleteLock(lockPath, token);
  return deleted ? { ok: true } : { ok: false, reason: "token-mismatch" };
}

/**
 * @description Read gate-state JSON; {} on missing/error. Never throws.
 * @param {string} statePath
 * @returns {Record<string, unknown>}
 */
export function readGateState(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function readGateStateForMutation(statePath) {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, reason: "gate-state-invalid-object" };
    }
    return { ok: true, state: parsed };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return { ok: true, state: {} };
    }
    return { ok: false, reason: "gate-state-unreadable" };
  }
}

/**
 * @description Atomic write (temp + rename). Never throws; returns boolean.
 * @param {string} statePath
 * @param {Record<string, unknown>} state
 * @returns {boolean}
 */
export function writeGateStateAtomic(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, statePath);
    return true;
  } catch {
    return false;
  }
}

/**
/** @description Under ownership-token lock: read → mergeGateStatePatch → atomic write → release.
 * @description Under ownership-token lock: read → mergeGateStatePatch → atomic write → release.
  * @description Under ownership-token lock: read → mergeGateStatePatch → atomic write → release.
 * @param {string} statePath
 * @param {Record<string, unknown>} patch
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => number, sleepMs?: (ms: number) => void }} [opts]
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, decision: "deny", reason: string }}
 */
export function mergeGateState(statePath, patch, opts = {}) {
  const acquired = acquireLock(statePath, opts);
  if (!acquired.ok) {
    return { ok: false, decision: "deny", reason: acquired.reason };
  }
  const token = acquired.token;
  try {
    const loaded = readGateStateForMutation(statePath);
    if (!loaded.ok) return { ok: false, decision: "deny", reason: loaded.reason };
    const prev = loaded.state;
    const applied = mergeGateStatePatch(prev, patch);
    if (!applied.ok) {
      return { ok: false, decision: "deny", reason: applied.reason ?? "patch-failed" };
    }
    if (!writeGateStateAtomic(statePath, applied.state)) {
      return { ok: false, decision: "deny", reason: "gate-state-write-failed" };
    }
    return { ok: true, state: applied.state };
  } finally {
    releaseLock(statePath, token);
  }
}

/**
 * @description Run fn under lock with current state; fn returns next state or patch result.
 * @param {string} statePath
 * @param {(prev: Record<string, unknown>) => Record<string, unknown> | { ok: false, reason: string }} fn
 * @param {{ timeoutMs?: number, staleMs?: number, now?: () => number, sleepMs?: (ms: number) => void }} [opts]
 * @returns {{ ok: true, state: Record<string, unknown> } | { ok: false, decision: "deny", reason: string }}
 */
export function withGateStateLock(statePath, fn, opts = {}) {
  const acquired = acquireLock(statePath, opts);
  if (!acquired.ok) {
    return { ok: false, decision: "deny", reason: acquired.reason };
  }
  const token = acquired.token;
  try {
    const loaded = readGateStateForMutation(statePath);
    if (!loaded.ok) return { ok: false, decision: "deny", reason: loaded.reason };
    const prev = loaded.state;
    let next;
    try {
      next = fn(prev);
    } catch {
      return { ok: false, decision: "deny", reason: "gate-state-fn-threw" };
    }
    if (next && typeof next === "object" && next.ok === false) {
      return { ok: false, decision: "deny", reason: String(next.reason ?? "fn-denied") };
    }
    const state = /** @type {Record<string, unknown>} */ (next);
    if (state === prev) return { ok: true, state };
    if (!writeGateStateAtomic(statePath, state)) {
      return { ok: false, decision: "deny", reason: "gate-state-write-failed" };
    }
    return { ok: true, state };
  } finally {
    releaseLock(statePath, token);
  }
}
