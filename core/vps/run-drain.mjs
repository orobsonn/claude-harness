#!/usr/bin/env node
/**
 * @description Standalone DRAIN-ONLY cron entry. Runs ONLY the observability outbox drain — it does
 * NOT dispatch an issue (Cron A) and does NOT run a PR review (the review cron). Scheduling THIS on a
 * short interval (e.g. every 3 min) gives a near-live Telegram feed without triggering the heavy side
 * effects of the other crons. Shares the SAME `drain.lock` (via drainWithLock) as Cron A and the
 * review cron so the three can never double-send. FAIL-OPEN: never throws, never delays.
 */
import { makeNotifier } from "./notify-telegram.mjs";
import { loadConfig } from "./run-cron-a.mjs";
import { drainWithLock } from "./drain-lock.mjs";

/**
 * @description Builds the best-effort notifier and drains the outbox once under the shared lock. A
 * no-op when the notifier is unconfigured (no token/chatId). Awaits notifier.drain() so the
 * short-lived process does not exit before in-flight sends settle.
 * @param {object} config
 * @param {{ drainOutbox?: Function }} [deps] - test seam for the drain
 * @returns {Promise<void>}
 */
export async function mainDrain(config, deps = {}) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  if (!notifier.enabled) return;
  try {
    await drainWithLock(config, { drainOutbox: deps.drainOutbox ?? notifier.drainOutbox });
  } finally {
    try {
      await notifier.drain();
    } catch {
      // fail-open
    }
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const arg = process.argv[2];
  const configPath = arg === "--config" ? process.argv[3] : arg;
  mainDrain(loadConfig(configPath)).catch((err) => {
    console.error(`run-drain: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
