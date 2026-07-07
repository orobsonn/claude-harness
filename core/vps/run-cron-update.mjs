#!/usr/bin/env node
/**
 * @description VPS engine auto-update COMPOSITION ROOT (fleet-level — ONE cron for the whole VPS,
 * like the reaper, because the engine dir is shared by every project's crons). A crontab invokes
 * `node core/vps/run-cron-update.mjs --config <engine-update.json>`. It wires the real git/fs seams
 * around the pure `performEngineUpdate` (engine-update.mjs) and notifies (non-critical) when the
 * engine actually advances.
 *
 * config: { engineLink, versionsDir, homeDir, keep?, notify? }
 *   - engineLink  — the published symlink the crontab points at (e.g. ~/.claude/harness-core)
 *   - versionsDir — where immutable per-sha version dirs live (e.g. ~/.claude/harness-core-versions)
 *   - homeDir     — for the Telegram token lookup (~/.claude/.dev.vars), mirroring the reaper
 *
 * Fail-open everywhere: a git/fs failure never throws out of the cron — it degrades to a no-op
 * (engine stays on its current version) and, for a genuine failure, an observable notify.
 */
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  readlinkSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  renameSync,
  rmSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import { join, dirname, resolve, sep } from "node:path";

import { performEngineUpdate } from "./engine-update.mjs";
import { makeNotifier } from "./notify-telegram.mjs";

/**
 * @description Prune grace window (ms): never delete a version dir younger than this. It must exceed
 * the longest a cron can hold a resolved-but-swapped-out engine version — run-cron-review's late,
 * engine-relative dynamic import of the codex module can fire minutes into a review. 2h is a wide
 * margin over any single review.
 */
const PRUNE_GRACE_MS = 2 * 60 * 60 * 1000;

/** @description `git -C <dir> <args>` stdout trimmed, or "" on any failure (fail-soft). */
function gitOut(dir, args) {
  const res = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (res.error || res.status !== 0) return "";
  return (res.stdout ?? "").trim();
}

/**
 * @description True iff engineLink is a symlink whose target lives under versionsDir — the marker of
 * a harness-managed engine. A plain-dir legacy install or an operator's own dev clone returns false.
 * @param {string} engineLink
 * @param {string} versionsDir
 * @returns {boolean}
 */
function realIsManaged(engineLink, versionsDir) {
  try {
    if (!lstatSync(engineLink).isSymbolicLink()) return false;
    const target = readlinkSync(engineLink);
    const resolved = resolve(dirname(engineLink), target);
    const base = resolve(versionsDir);
    return resolved === base || resolved.startsWith(base + sep);
  } catch {
    return false;
  }
}

/** @description sha the engine symlink currently resolves to (`git rev-parse HEAD` follows it). "" on failure. */
function realGetActiveSha(engineLink) {
  return gitOut(engineLink, ["rev-parse", "HEAD"]);
}

/** @description sha of origin/main via ls-remote (no fetch, no object download). "" on failure. */
function realGetRemoteSha(engineLink) {
  const line = gitOut(engineLink, ["ls-remote", "origin", "refs/heads/main"]);
  return line ? line.split(/\s+/)[0] : "";
}

/**
 * @description Clones the given sha's main into an immutable `<versionsDir>/<sha>` dir and returns
 * its path. Idempotent: an already-present version dir is reused (covers a prior pass that cloned but
 * failed to swap). Clones into a private temp dir first, then renames — a half-finished clone is never
 * visible under the canonical version path. Throws on clone failure (the caller must NOT activate).
 * @param {string} sha
 * @param {string} engineLink
 * @param {string} versionsDir
 * @returns {string}
 */
function realPrepareVersion(sha, engineLink, versionsDir) {
  const dest = join(versionsDir, sha);
  if (existsSync(dest)) return dest;

  const url = gitOut(engineLink, ["remote", "get-url", "origin"]);
  if (!url) throw new Error("run-cron-update: cannot resolve origin url to clone the new engine version");

  mkdirSync(versionsDir, { recursive: true });
  const tmp = join(versionsDir, `.tmp-${sha}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  const res = spawnSync("git", ["clone", "--depth", "1", "--branch", "main", url, tmp], { stdio: ["ignore", "pipe", "pipe"] });
  if (res.error || res.status !== 0) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`run-cron-update: git clone of the new engine version failed (status ${res.status})`);
  }
  renameSync(tmp, dest);
  return dest;
}

/**
 * @description Atomically points the engine symlink at `path`: create a private temp symlink, then
 * rename it onto engineLink (rename of a symlink is atomic on the same filesystem). A concurrently-
 * starting cron sees either the old or the new whole target, never a missing/partial link.
 * @param {string} path
 * @param {string} engineLink
 * @returns {void}
 */
function realActivate(path, engineLink) {
  const tmpLink = `${engineLink}.tmp-${process.pid}`;
  rmSync(tmpLink, { force: true });
  symlinkSync(path, tmpLink);
  renameSync(tmpLink, engineLink);
}

/** @description Every version dir under versionsDir as {sha, mtimeMs, path}; hidden/temp entries skipped. */
function realListVersions(versionsDir) {
  let entries;
  try {
    entries = readdirSync(versionsDir);
  } catch {
    return [];
  }
  const versions = [];
  for (const name of entries) {
    if (name.startsWith(".")) continue; // skip .tmp-* staging dirs
    const path = join(versionsDir, name);
    try {
      const st = statSync(path);
      if (st.isDirectory()) versions.push({ sha: name, mtimeMs: st.mtimeMs, path });
    } catch {
      // unreadable entry contributes nothing
    }
  }
  return versions;
}

/** @description Removes a pruned version dir (best-effort; never throws — rmSync force still throws on
 * EACCES/EBUSY, so swallow it: a stuck old version dir is inert and retried next pass). */
function realPruneVersion(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // best-effort — a prune failure must never bubble up and mask a completed swap
  }
}

/**
 * @description Runs one engine-update pass, wiring the real git/fs seams around performEngineUpdate.
 * Notifies engine-updated on a real advance (non-critical), engine-update-failed on a thrown seam
 * (observable), and stays silent on a no-op. NEVER throws out of the cron.
 * @param {object} config
 * @param {object} [deps] - injectable seams (performEngineUpdate, notify) for hermetic testing.
 * @returns {{updated: boolean, reason?: string, from?: string, to?: string}}
 */
export function runEngineUpdate(config, deps = {}) {
  const perform = deps.performEngineUpdate ?? performEngineUpdate;
  const notify = deps.notify ?? (() => {});
  const { engineLink, versionsDir, keep } = config;

  try {
    const result = perform({
      isManaged: () => realIsManaged(engineLink, versionsDir),
      getActiveSha: () => realGetActiveSha(engineLink),
      getRemoteSha: () => realGetRemoteSha(engineLink),
      prepareVersion: (sha) => realPrepareVersion(sha, engineLink, versionsDir),
      activate: (path) => realActivate(path, engineLink),
      listVersions: () => realListVersions(versionsDir),
      pruneVersion: realPruneVersion,
      keep: keep ?? 3,
      now: Date.now(),
      pruneGraceMs: PRUNE_GRACE_MS,
    });

    if (result.updated) {
      try {
        notify({ type: "engine-updated", project: "harness", from: result.from, to: result.to });
      } catch {
        // fail-open — a notify failure never breaks the update
      }
    }
    return result;
  } catch (err) {
    try {
      notify({ type: "engine-update-failed", project: "harness", message: err instanceof Error ? err.message : String(err) });
    } catch {
      // fail-open
    }
    return { updated: false, reason: "error" };
  }
}

/** @description Minimal config loader for the fleet-level engine-update cron (no per-project fields). */
export function loadUpdateConfig(source) {
  const cfg = typeof source === "string" ? JSON.parse(readFileSync(source, "utf8")) : source;
  for (const field of ["engineLink", "versionsDir", "homeDir"]) {
    if (!cfg[field]) throw new Error(`loadUpdateConfig: missing required field "${field}"`);
  }
  return { ...cfg };
}

/**
 * @description CLI wrapper: builds the fleet-level notifier (token from ~/.claude/.dev.vars via
 * makeNotifier), runs runEngineUpdate with it injected, and awaits drain() before exit so a
 * notification is never dropped.
 * @param {object} config
 * @returns {Promise<void>}
 */
export async function mainCronUpdate(config) {
  const notifier = makeNotifier(config, { homeDir: config.homeDir });
  try {
    runEngineUpdate(config, { notify: notifier.notify });
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
  mainCronUpdate(loadUpdateConfig(configPath)).catch((err) => {
    console.error(`run-cron-update: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
