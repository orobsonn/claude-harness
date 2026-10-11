/**
 * @description Ownership-token file lock shared by host state writers (OpenCode gate-state, Pi and
 * Claude Code task registries). Exclusive create (wx) of `<path>.lock` holding {token,pid,createdAt};
 * stale only when older than LOCK_STALE_MS AND its pid is dead; release is compare-and-delete.
 * Moved verbatim from core/opencode/lib/gate-state.mjs, which re-exports it unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

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

  // Always attempt at least once, and once more right after breaking a stale lock: on a
  // loaded host the process can be descheduled past a short timeout, and a free (or just
  // freed) lock must never be reported busy untried. Bounded so a stale-lock storm still ends.
  let forcedAttempts = 1;
  let staleBreaks = 0;
  while (forcedAttempts > 0 || nowFn() < deadline) {
    forcedAttempts = Math.max(0, forcedAttempts - 1);
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
        if (staleBreaks < 3) {
          staleBreaks += 1;
          forcedAttempts = 1;
        }
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
          if (staleBreaks < 3) {
            staleBreaks += 1;
            forcedAttempts = 1;
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
