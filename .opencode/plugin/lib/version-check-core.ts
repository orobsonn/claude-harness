/**
 * @description Version-check plugin logic — harness staleness advisory only, no blocking. Lives
 * OUTSIDE `../version-check.ts` on purpose: that file is loaded directly by
 * OpenCode as a plugin, and its real 1.18.7 plugin loader crashes (bisected live, 2026-07-27,
 * against a headless `opencode serve` with no attached TUI: `"failed to load plugin" ...
 * "undefined is not an object (evaluating 'b.major')"`, cascading into a broken
 * `/config/providers`) when a plugin file has more than one export. This module is a normal
 * import, never loaded as a plugin itself, so it can export every function individually for unit
 * testing without tripping that loader bug — `../version-check.ts` re-exports only `default`.
 */
import type { PluginInput } from "@opencode-ai/plugin"
import { execFileSync } from "node:child_process"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

type Semver = { major: number; minor: number; patch: number }

type VersionCache = { tag: string; cachedAt: number }

type VersionCheckDeps = {
  readLocalVersion?: (projectRoot: string) => string | null
  fetchRemoteTag?: () => string | null
  readCache?: (projectRoot: string) => unknown
  writeCache?: (projectRoot: string, value: VersionCache) => void
  nowMs?: () => number
  warn?: (message: string) => void
}

/** Remote-tag cache budget — avoids a `gh`/network round trip on every session bootstrap. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/**
 * @description Usable project root candidate. OpenCode reports worktree "/" outside a git
 * repository, which would resolve version state against the filesystem root.
 */
function isUsableRoot(candidate: unknown): candidate is string {
  return typeof candidate === "string" && candidate.length > 0 && candidate !== "/"
}

/**
 * @description Resolve project root — never empty.
 */
export function resolveProjectRoot(directory?: unknown, worktree?: unknown): string {
  if (isUsableRoot(worktree)) return worktree
  if (isUsableRoot(directory)) return directory
  if (
    directory != null &&
    typeof directory === "object" &&
    !Array.isArray(directory)
  ) {
    const nested = (directory as { directory?: unknown }).directory
    if (isUsableRoot(nested)) return nested
  }
  return process.cwd()
}

/**
 * @description Delivers an advisory message through the console/deps.warn channel only.
 * Bisected live against a real `opencode serve` process (2026-07-27, no attached TUI): merely
 * CALLING `client.tui.showToast(...)` — resolved, never-settling, late-rejecting, awaited, or
 * fire-and-forget, every shape tried — crashed the server hard enough to break unrelated endpoints
 * (`/config/providers`); skipping staleness logic never reproduced it, skipping this
 * one call always fixed it. The failure lives inside the vendored OpenCode binary's toast/session
 * RPC handling for a plugin with no real TUI attached, not in anything on this side of the call —
 * there is no promise-handling pattern here that makes invoking it safe. The TUI toast is
 * permanently retired from this plugin; `warn` is the only advisory channel.
 */
async function deliverAdvisory(
  message: string,
  deps: Pick<VersionCheckDeps, "warn">,
): Promise<void> {
  try {
    if (deps.warn) deps.warn(message)
    else console.warn(message)
  } catch {
    // fail-open
  }
}

/**
 * @description Extracts leading semver from a version stamp. Handles all 3 stamp shapes
 * `git describe --tags --always` produces: exact tag (`v0.49.8`), tag + commits ahead
 * (`v0.49.8-3-gabc1234`), and no reachable tag at all (a bare SHA) — the last has no
 * comparable version and resolves to null (decideStale then stays silent, never throws).
 */
export function parseSemver(stamp: unknown): Semver | null {
  if (typeof stamp !== "string") return null
  const match = stamp.match(/^v?(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

/** @description Numeric semver comparison — never lexical. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1
  return 0
}

/**
 * @description Decides whether the vendored stamp is behind the latest release.
 * Returns the advisory prose, or null when up to date / either stamp is unparseable.
 */
export function decideStale({ localStamp, remoteTag }: { localStamp: string; remoteTag: string }): string | null {
  const local = parseSemver(localStamp)
  const remote = parseSemver(remoteTag)
  if (!local || !remote) return null
  if (compareSemver(local, remote) >= 0) return null
  return `⚠️ Harness OpenCode desatualizado — vendored ${localStamp}, disponível ${remoteTag}. Rode /updating-harness e reinicie a sessão para carregar a versão nova.`
}

/**
 * @description Resolves the latest release tag, caching so a session bootstrap doesn't hit
 * the network every time. Cache miss/expired triggers one `fetchRemoteTag`.
 */
export function resolveRemoteTag({
  nowMs,
  readCache,
  writeCache,
  fetchRemoteTag,
  ttlMs,
}: {
  nowMs: number
  readCache: () => unknown
  writeCache: (value: VersionCache) => void
  fetchRemoteTag: () => string | null
  ttlMs: number
}): string | null {
  const cache = readCache()
  if (
    cache &&
    typeof cache === "object" &&
    typeof (cache as VersionCache).tag === "string" &&
    typeof (cache as VersionCache).cachedAt === "number" &&
    (cache as VersionCache).cachedAt <= nowMs &&
    nowMs - (cache as VersionCache).cachedAt < ttlMs
  ) {
    return (cache as VersionCache).tag
  }
  const tag = fetchRemoteTag()
  if (tag) {
    writeCache({ tag, cachedAt: nowMs })
    return tag
  }
  return null
}

function readLocalVersionFromDisk(projectRoot: string): string | null {
  try {
    const content = readFileSync(join(projectRoot, ".opencode", ".harness-version"), "utf8")
    const firstLine = content.split("\n")[0]?.trim()
    return firstLine || null
  } catch {
    return null
  }
}

function readCacheFromDisk(projectRoot: string): unknown {
  try {
    return JSON.parse(readFileSync(join(projectRoot, ".opencode", ".harness-version-check-cache"), "utf8"))
  } catch {
    return null
  }
}

function writeCacheToDisk(projectRoot: string, value: VersionCache): void {
  try {
    const tmpPath = join(projectRoot, ".opencode", ".harness-version-check-cache.tmp")
    const finalPath = join(projectRoot, ".opencode", ".harness-version-check-cache")
    writeFileSync(tmpPath, JSON.stringify(value), "utf8")
    renameSync(tmpPath, finalPath)
  } catch {
    // fail-soft
  }
}

/** @description `gh` first, `curl` against the GitHub API as fallback — both budgeted at 2s. */
function fetchRemoteTagLive(): string | null {
  try {
    const output = execFileSync(
      "gh",
      ["release", "view", "--repo", "orobsonn/claude-harness", "--json", "tagName", "-q", ".tagName"],
      { stdio: ["pipe", "pipe", "ignore"], timeout: 2000, encoding: "utf8" },
    )
    const tag = output.trim()
    return tag || null
  } catch {
    try {
      const output = execFileSync(
        "curl",
        ["-fs", "--max-time", "2", "https://api.github.com/repos/orobsonn/claude-harness/releases/latest"],
        { stdio: ["pipe", "pipe", "ignore"], timeout: 2000, encoding: "utf8" },
      )
      const data = JSON.parse(output)
      const tag = typeof data.tag_name === "string" ? data.tag_name.trim() : ""
      return tag || null
    } catch {
      return null
    }
  }
}

/**
 * @description Checks whether the vendored `.opencode/.harness-version` stamp is behind the
 * latest release. Fail-soft by construction: a missing stamp, an unreachable `gh`/network, or
 * any I/O error resolves to null — no advisory, no throw, no bootstrap delay beyond the
 * cached/budgeted remote lookup.
 */
export function checkHarnessVersionStale(projectRoot: string, deps: VersionCheckDeps): string | null {
  try {
    const readLocalVersion = deps.readLocalVersion ?? readLocalVersionFromDisk
    const localStamp = readLocalVersion(projectRoot)
    if (!localStamp) return null

    const nowMs = deps.nowMs ? deps.nowMs() : Date.now()
    const fetchRemoteTag = deps.fetchRemoteTag ?? fetchRemoteTagLive
    const remoteTag = resolveRemoteTag({
      nowMs,
      readCache: () => (deps.readCache ? deps.readCache(projectRoot) : readCacheFromDisk(projectRoot)),
      writeCache: (value) => (deps.writeCache ? deps.writeCache(projectRoot, value) : writeCacheToDisk(projectRoot, value)),
      fetchRemoteTag,
      ttlMs: CACHE_TTL_MS,
    })
    if (!remoteTag) return null

    return decideStale({ localStamp, remoteTag })
  } catch {
    return null
  }
}

/**
 * @description OpenCode plugin logic — harness-staleness advisory only (fail-open).
 * Called from the thin `../version-check.ts` default export; never loaded as a plugin itself.
 */
export async function createVersionCheck(
  { directory, worktree }: Pick<PluginInput, "directory" | "worktree">,
  deps: VersionCheckDeps = {},
) {
  const projectRoot = resolveProjectRoot(directory, worktree)

  try {
    const staleMessage = checkHarnessVersionStale(projectRoot, deps)
    if (staleMessage) await deliverAdvisory(staleMessage, deps)
  } catch {
    // fail-soft — a version-check error must never block bootstrap
  }

  return {}
}
