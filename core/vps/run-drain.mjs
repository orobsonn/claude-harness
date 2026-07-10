#!/usr/bin/env node
/**
 * @description Standalone DRAIN-ONLY cron entry. Runs ONLY the observability outbox drain — it does
 * NOT dispatch an issue (Cron A) and does NOT run a PR review (the review cron). Scheduling THIS on a
 * short interval (e.g. every 3 min) gives a near-live Telegram feed without triggering the heavy side
 * effects of the other crons. Shares the SAME `drain.lock` (via drainWithLock) as Cron A and the
 * review cron so the three can never double-send. FAIL-OPEN: never throws, never delays.
 */
import { spawnSync } from "node:child_process";

import { makeNotifier } from "./notify-telegram.mjs";
import { loadConfig } from "./run-cron-a.mjs";
import { drainWithLock } from "./drain-lock.mjs";
import { makeDefaultIssueClosed } from "./run-reaper.mjs";

/** @description Finite timeout (ms) + kill signal applied to every gh spawnSync the issueOpen seam
 * below issues — #235/#ac-1.4: a hung gh process (network/auth stall) must NEVER block the drain
 * indefinitely. A timed-out spawnSync sets res.error/a non-zero status, which makeDefaultIssueClosed
 * already maps to null -> our issueOpen wrapper maps null to false (do-not-mint) with no change
 * needed inside makeDefaultIssueClosed itself. */
const GH_SPAWN_TIMEOUT_MS = 5000;

/**
 * @description Builds a real issueOpen(issueNumber) seam for this project's single-repo config,
 * reusing run-reaper.mjs's existing gh-scoped makeDefaultIssueClosed (no new dependency, no
 * gh-scoping duplicated). Returns a TRI-STATE, never collapsed to boolean: `true` = confirmed OPEN
 * (authorizes a self-heal re-mint), `false` = confirmed CLOSED (authorizes finalizing the run
 * terminal), `null` = UNKNOWN (a gh outage/timeout — must authorize NEITHER a mint nor a finalize;
 * collapsing an outage into "closed" would wrongly terminate a genuinely active run on a transient
 * blip). The underlying spawn's finite timeout keeps the caller itself fail-open (never blocked).
 * @param {{ owner: string, repo: string }} config
 * @param {{ spawn?: Function }} [deps] - test seam; defaults to the real spawnSync
 * @returns {(issueNumber: number) => boolean | null}
 */
export function makeIssueOpen(config, deps = {}) {
  const spawn = deps.spawn ?? spawnSync;
  const spawnWithTimeout = (cmd, args, opts) =>
    spawn(cmd, args, { ...opts, timeout: GH_SPAWN_TIMEOUT_MS, killSignal: "SIGKILL" });
  const issueClosed = makeDefaultIssueClosed(spawnWithTimeout, config.owner, config.repo);
  return (issueNumber) => {
    const closed = issueClosed(issueNumber);
    if (closed === true) return false;
    if (closed === false) return true;
    return null;
  };
}

/**
 * @description Builds the best-effort notifier and drains the outbox once under the shared lock. A
 * no-op when the notifier is unconfigured (no token/chatId). Awaits notifier.drain() so the
 * short-lived process does not exit before in-flight sends settle. Wires a real issueOpen seam
 * (#235/#ac-1.3) into the drain so the self-heal branch never re-mints a topic for a closed issue.
 * @param {object} config
 * @param {{ drainOutbox?: Function, spawn?: Function }} [deps] - test seams for the drain / gh spawn
 * @returns {Promise<void>}
 */
export async function mainDrain(config, deps = {}) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  if (!notifier.enabled) return;
  const issueOpen = makeIssueOpen(config, { spawn: deps.spawn });
  const baseDrainOutbox = deps.drainOutbox ?? notifier.drainOutbox;
  try {
    await drainWithLock(config, {
      drainOutbox: (opts) => baseDrainOutbox({ ...opts, issueOpen }),
    });
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
