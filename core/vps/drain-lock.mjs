/**
 * @description Shared "drain the observability outbox once, under the per-project drain.lock" helper.
 * The SAME `drain.lock` is shared by the dedicated drain cron (run-drain.mjs), Cron A (post-dispatch)
 * and the review cron, so the three can never double-send the same event. A 15-min stale-reclaim
 * means an orphaned lock (a drain killed mid-run) never mutes the feed forever. FAIL-OPEN: never
 * throws, never delays a cron — a busy lock, an unreadable stat, or a drain error all resolve quietly.
 */
import { openSync, closeSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/** @description Reclaim an orphaned drain.lock older than this (a drain killed mid-run). */
const DRAIN_LOCK_STALE_MS = 15 * 60 * 1000;

/**
 * @description Acquires `<stateDir>/drain.lock` (wx, with stale-reclaim), runs `drainOutbox` once,
 * then releases the lock. When the lock is held by another live drain, this tick is skipped (the next
 * drains). The `drainOutbox` seam is the bound `notifier.drainOutbox` (chatId/threadId already
 * resolved) or a test spy.
 * @param {{ stateDir: string, homeDir?: string, notify?: { limitPerMinute?: number, sendDelayMs?: number } }} config
 * @param {{ drainOutbox: (opts: object) => Promise<void> }} deps
 * @returns {Promise<void>}
 */
export async function drainWithLock(config, { drainOutbox } = {}) {
  if (typeof drainOutbox !== "function" || !config || !config.stateDir) return;
  const lockPath = join(config.stateDir, "drain.lock");
  let lockFd = null;
  try {
    lockFd = openSync(lockPath, "wx");
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > DRAIN_LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        lockFd = openSync(lockPath, "wx");
      }
    } catch {
      return; // still busy / unreadable — a concurrent drain holds it; the next tick drains
    }
  }
  if (lockFd === null) return;
  try {
    await drainOutbox({
      stateDir: config.stateDir,
      homeDir: config.homeDir,
      limitPerMinute: config.notify?.limitPerMinute ?? 20,
      sendDelayMs: config.notify?.sendDelayMs ?? 1100,
    });
  } catch {
    // fail-open: a drain failure never throws or delays the cron
  } finally {
    try {
      closeSync(lockFd);
    } catch {
      // best-effort fd close
    }
    try {
      rmSync(lockPath, { force: true });
    } catch {
      // best-effort lock cleanup
    }
  }
}
