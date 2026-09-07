/** @description SessionStart(startup) hook — warns when vendored harness is behind latest release. */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Pure functions — no I/O, testable
// ---------------------------------------------------------------------------

/**
 * Extracts leading semver from a string.
 *
 * @param {string} s - Input string
 * @returns {{ major: number, minor: number, patch: number } | null} Parsed semver or null
 */
export function parseSemver(s) {
  if (typeof s !== "string") return null;
  const match = s.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

/**
 * Compares two semver objects numerically.
 *
 * @param {{ major: number, minor: number, patch: number }} a - First semver
 * @param {{ major: number, minor: number, patch: number }} b - Second semver
 * @returns {-1 | 0 | 1} -1 if a < b, 1 if a > b, 0 if equal
 */
export function compareSemver(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Decides whether to emit a warning based on local and remote versions.
 *
 * @param {{ localVersion: string, remoteTag: string }} params - Version parameters
 * @returns {{ systemMessage: string } | null} Warning message or null
 */
export function decide({ localVersion, remoteTag }) {
  const localSem = parseSemver(localVersion);
  const remoteSem = parseSemver(remoteTag);

  if (!localSem || !remoteSem) return null;

  if (compareSemver(localSem, remoteSem) >= 0) return null;

  return {
    systemMessage: `⚠️ Claude Harness desatualizado — vendored ${localVersion}, disponível ${remoteTag}. Rode /updating-harness e reinicie a sessão para carregar a versão nova.`
  };
}

/**
 * Resolves the remote tag with caching.
 *
 * @param {{ nowMs: number, readCache: Function, writeCache: Function, fetchRemoteTag: Function, ttlMs: number }} params - Resolution parameters
 * @returns {string | null} Remote tag or null
 */
export function resolveRemoteTag({ nowMs, readCache, writeCache, fetchRemoteTag, ttlMs }) {
  const cache = readCache();

  if (
    cache &&
    typeof cache === "object" &&
    typeof cache.tag === "string" &&
    typeof cache.cachedAt === "number" &&
    cache.cachedAt <= nowMs &&
    (nowMs - cache.cachedAt) < ttlMs
  ) {
    return cache.tag;
  }

  const tag = fetchRemoteTag();
  if (tag && typeof tag === "string") {
    writeCache({ tag, cachedAt: nowMs });
    return tag;
  }

  return null;
}

/**
 * Handles the version check logic.
 *
 * @param {unknown} payload - Hook payload
 * @param {{ env?: Record<string, string>, readLocalVersion: Function, resolveRemoteTag: Function, nowMs?: number }} opts - Options
 * @returns {{ systemMessage: string, continue: true } | null} Result or null
 */
export function handle(payload, opts) {
  if (opts.env && opts.env.CLAUDE_CODE_REMOTE != null) return null;

  try {
    const local = opts.readLocalVersion();
    if (!local) return null;

    const remote = opts.resolveRemoteTag({ nowMs: opts.nowMs });
    if (!remote) return null;

    const d = decide({ localVersion: local, remoteTag: remote });
    if (!d) return null;

    return { ...d, continue: true };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Impure I/O layer — real implementations used by CLI
// ---------------------------------------------------------------------------

/**
 * Reads the local version from disk.
 *
 * @returns {string | null} Local version or null
 */
function readLocalVersionFromDisk() {
  try {
    const content = fs.readFileSync(".claude/.harness-version", "utf8");
    const firstLine = content.split("\n")[0]?.trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

/**
 * Reads the cache from disk.
 *
 * @returns {unknown} Cache object or null
 */
function readCacheFromDisk() {
  try {
    const content = fs.readFileSync(".claude/.harness-version-check-cache", "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Writes the cache to disk atomically.
 *
 * @param {unknown} obj - Object to write
 */
function writeCacheToDisk(obj) {
  try {
    const tmpPath = ".claude/.harness-version-check-cache.tmp";
    const finalPath = ".claude/.harness-version-check-cache";
    fs.writeFileSync(tmpPath, JSON.stringify(obj), "utf8");
    fs.renameSync(tmpPath, finalPath);
  } catch {
    // Fail silently
  }
}

/**
 * Fetches the remote tag from GitHub.
 *
 * @returns {string | null} Remote tag or null
 */
function fetchRemoteTagLive() {
  try {
    const output = execFileSync(
      "gh",
      ["release", "view", "--repo", "orobsonn/claude-harness", "--json", "tagName", "-q", ".tagName"],
      { stdio: ["pipe", "pipe", "ignore"], timeout: 2000, encoding: "utf8" }
    );
    const tag = output.trim();
    return tag || null;
  } catch {
    try {
      const output = execFileSync(
        "curl",
        ["-fs", "--max-time", "2", "https://api.github.com/repos/orobsonn/claude-harness/releases/latest"],
        { stdio: ["pipe", "pipe", "ignore"], timeout: 2000, encoding: "utf8" }
      );
      const data = JSON.parse(output);
      const tag = data.tag_name?.trim();
      return tag || null;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry point — guarded so test imports do not trigger side effects
// ---------------------------------------------------------------------------

function isDirectCli() {
  if (!process.argv[1]) return false;
  const modulePath = fileURLToPath(import.meta.url);
  try {
    return fs.realpathSync(process.argv[1]) === modulePath;
  } catch {
    return process.argv[1] === modulePath;
  }
}

if (isDirectCli()) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  let result;
  try {
    result = handle(payload, {
      env: process.env,
      readLocalVersion: readLocalVersionFromDisk,
      resolveRemoteTag: (a) => resolveRemoteTag({
        ...a,
        readCache: readCacheFromDisk,
        writeCache: writeCacheToDisk,
        fetchRemoteTag: fetchRemoteTagLive,
        ttlMs: 6 * 60 * 60 * 1000
      }),
      nowMs: Date.now()
    });
  } catch {
    process.exit(0);
  }

  if (result !== null) {
    try {
      process.stdout.write(JSON.stringify(result) + "\n");
    } catch {
      // fail-open: stdout error must not cause non-zero exit
    }
  }

  process.exit(0);
}